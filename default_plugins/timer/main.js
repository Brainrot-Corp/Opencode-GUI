// Timer — single countdown timer (plugin).
// Titlebar button (live countdown) + floating Apple-Clock-style Overlay share
// localStorage "oc.timer":
//   {open,label,h,m,s,totalMs,remainingMs,endsAt,status,geom:{x,y}}
// status: "idle" | "running" | "paused" | "ringing". One timer at a time:
// Start replaces any existing timer. Timing is endsAt-based so reloads and
// background throttling don't drift. Ringing forces open + loops an alarm
// until Stop (persists across reloads).

const KEY = "oc.timer";
const EVT = "oc:timer:changed";
const MAX_MS = 24 * 3600 * 1000; // 24h
const PRESETS = [
  { label: "1m", ms: 60 * 1000 },
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "25m", ms: 25 * 60 * 1000 },
  { label: "45m", ms: 45 * 60 * 1000 },
  { label: "1h", ms: 3600 * 1000 },
];

function clamp(n, a, b){ return Math.min(Math.max(n, a), b); }

function defaultGeom(){
  const w = 320, h = 420;
  const x = Math.max(12, Math.floor((window.innerWidth - w) / 2));
  const y = Math.max(12, Math.floor((window.innerHeight - h) / 2 - 20));
  return { x, y };
}

function num(v, fb, lo, hi){
  const n = Math.floor(Number(v));
  if(!Number.isFinite(n)) return fb;
  return clamp(n, lo, hi);
}

function load(){
  try{
    const raw = localStorage.getItem(KEY);
    const fb = { open:false, label:"", h:0, m:5, s:0, totalMs:0, remainingMs:0, endsAt:null, status:"idle", geom:defaultGeom() };
    if(!raw) return fb;
    const p = JSON.parse(raw);
    const st = ["idle","running","paused","ringing"].includes(p.status) ? p.status : "idle";
    const totalMs = clamp(Number(p.totalMs) || 0, 0, MAX_MS);
    let remainingMs = clamp(Number(p.remainingMs) || 0, 0, MAX_MS);
    let endsAt = typeof p.endsAt === "number" && p.endsAt > 0 ? p.endsAt : null;
    let geom = p.geom && typeof p.geom === "object" ? p.geom : defaultGeom();
    geom = {
      x: clamp(Number(geom.x) || 0, 0, Math.max(0, window.innerWidth - 200)),
      y: clamp(Number(geom.y) || 0, 0, Math.max(0, window.innerHeight - 80)),
    };
    let open = !!p.open;
    // normalize without writing: expired running timers surface as ringing,
    // running without endsAt is corrupt → idle
    if(st === "running"){
      if(endsAt && endsAt <= Date.now()) return { ...fb, ...clean(p), open:true, status:"ringing", remainingMs:0, endsAt:null, totalMs, geom };
      if(!endsAt) return { ...fb, ...clean(p), status:"idle", totalMs, remainingMs:0, endsAt:null, geom };
      remainingMs = clamp(endsAt - Date.now(), 0, MAX_MS);
    }
    if(st === "ringing") open = true;
    return {
      open,
      label: String(p.label || "").slice(0, 80),
      h: num(p.h, 0, 0, 24), m: num(p.m, 5, 0, 59), s: num(p.s, 0, 0, 59),
      totalMs, remainingMs, endsAt,
      status: st,
      geom,
    };
  }catch{ return { open:false, label:"", h:0, m:5, s:0, totalMs:0, remainingMs:0, endsAt:null, status:"idle", geom:defaultGeom() }; }
}

// re-slice of persisted input fields (used by the ringing normalization above)
function clean(p){
  return {
    label: String(p.label || "").slice(0, 80),
    h: num(p.h, 0, 0, 24), m: num(p.m, 5, 0, 59), s: num(p.s, 0, 0, 59),
  };
}

function save(state, notify = true){
  try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch{}
  if(notify) try{ window.dispatchEvent(new CustomEvent(EVT)); }catch{}
}
function equal(a, b){ try{ return JSON.stringify(a) === JSON.stringify(b); }catch{ return false; } }

// ms left for a snapshot at `now`
function remainingOf(st, now){
  if(st.status === "running" && st.endsAt) return Math.max(0, st.endsAt - now);
  return clamp(Number(st.remainingMs) || 0, 0, MAX_MS);
}

// "H:MM:SS" when >= 1h else "M:SS" — ceil so the last second reads 0:01, not 0:00
function fmt(ms){
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p2 = (n)=> String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

export default function activate(api){
  const { h, useState, useEffect, useRef } = api;

  // ---- finish alarm: own WebAudio loop so it rings even if "attention" is muted ----
  let alarmIv = 0;
  let actx = null;
  function tone(at, f0, f1, dur, vol){
    try{
      const t = actx.currentTime + at;
      const o = actx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      const g = actx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    }catch{}
  }
  function beep(){
    try{
      if(!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if(actx.state === "suspended") void actx.resume().catch(()=>{});
      tone(0, 880, 880, 0.14, 0.5);
      tone(0.2, 880, 880, 0.14, 0.5);
      tone(0.4, 1174, 1174, 0.3, 0.5);
    }catch{}
  }
  function startAlarm(){
    if(alarmIv) return;
    beep();
    alarmIv = window.setInterval(beep, 1200);
  }
  function stopAlarm(){
    if(alarmIv){ clearInterval(alarmIv); alarmIv = 0; }
  }

  // shared transition check — returns the ringing snapshot or null
  function checkRing(snap){
    if(snap.status === "running" && snap.endsAt && snap.endsAt <= Date.now()){
      const next = { ...snap, status:"ringing", open:true, remainingMs:0, endsAt:null };
      save(next);
      try{ api.playSound("attention"); }catch{}
      startAlarm();
      return next;
    }
    return null;
  }

  function useTimerSync(){
    const [snap, setSnap] = useState(()=> load());
    useEffect(()=>{
      const sync = ()=>{
        const next = load();
        setSnap((prev)=>{
          if(equal(prev, next)) return prev;
          if(next.status === "ringing") startAlarm(); else stopAlarm();
          return next;
        });
      };
      window.addEventListener(EVT, sync);
      window.addEventListener("storage", sync);
      return ()=>{ window.removeEventListener(EVT, sync); window.removeEventListener("storage", sync); };
    },[]);
    // persist an expired running timer as ringing on boot; a fresh mount
    // always restarts the alarm for ringing, so unmount can silence outright
    useEffect(()=>{
      if(snap.status === "ringing"){ save(snap); startAlarm(); }
      return ()=>{ stopAlarm(); };
    },[]);
    return [snap, setSnap];
  }

  function toggleTimer(){
    const s = load();
    // ringing forces open — toggle is a no-op until stopped
    if(s.status === "ringing" && !s.open){ s.open = true; save(s); return; }
    if(s.status === "ringing") return;
    s.open = !s.open;
    save(s);
    try{ api.playSound(s.open ? "expand" : "collapse"); }catch{}
  }

  function binding(){
    try{
      const ph = api.settings().pluginHotkeys || {};
      const v = ph["timer:toggle"];
      if(v === null) return null;
      if(typeof v === "string" && v) return v;
      return "Alt+T";
    }catch{ return "Alt+T"; }
  }

  function TitlebarBtn(){
    const [snap, setSnap] = useTimerSync();
    const [bind, setBind] = useState(binding);
    const [, setTick] = useState(0);

    useEffect(()=>{
      const iv = window.setInterval(()=>{
        const cur = load();
        const rung = checkRing(cur);
        if(rung){ setSnap((prev)=> equal(prev, rung) ? prev : rung); return; }
        if(cur.status === "running" || cur.status === "ringing") setTick((t)=> t + 1);
        setSnap((prev)=> equal(prev, cur) ? prev : cur);
      }, 500);
      const onSync = ()=> setBind(binding());
      window.addEventListener(EVT, onSync);
      return ()=>{ window.clearInterval(iv); window.removeEventListener(EVT, onSync); };
    },[]);

    const active = snap.status === "running" || snap.status === "paused" || snap.status === "ringing";
    const rem = remainingOf(snap, Date.now());
    const tip = snap.status === "ringing"
      ? "Timer finished — open and Stop"
      : snap.status === "running"
        ? `Pause / hide timer (${fmt(rem)} left${snap.label ? ` — ${snap.label}` : ""})`
        : snap.status === "paused"
          ? `Resume / hide timer (${fmt(rem)} left${snap.label ? ` — ${snap.label}` : ""})`
          : (bind ? `Show timer (${bind})` : "Show timer");
    return h("button", {
      className: `icon-btn timer-tb${snap.open ? " on" : ""}${snap.status === "ringing" ? " ringing" : ""}${snap.status === "paused" ? " paused" : ""}`,
      "data-tip": tip,
      "aria-pressed": snap.open,
      "aria-label": "Timer",
      onClick: ()=>{
        // quick pause/resume on middle-click; plain click toggles the panel
        toggleTimer();
      },
      onMouseDown: (e)=>{
        if(e.button === 1){
          e.preventDefault();
          const s = load();
          if(s.status === "running") pauseTimer();
          else if(s.status === "paused") resumeTimer();
        }
      },
    },
      h("i", { className:"fa-solid fa-stopwatch" }),
      active ? h("span", { className:"timer-tb-time" }, fmt(rem)) : null
    );
  }

  function pauseTimer(){
    const s = load();
    if(s.status !== "running") return;
    s.remainingMs = remainingOf(s, Date.now());
    s.endsAt = null;
    s.status = "paused";
    save(s);
    try{ api.playSound("click"); }catch{}
  }
  function resumeTimer(){
    const s = load();
    if(s.status !== "paused" || !(s.remainingMs > 0)) return;
    s.endsAt = Date.now() + s.remainingMs;
    s.status = "running";
    save(s);
    try{ api.playSound("click"); }catch{}
  }
  function stopTimer(){
    const s = load();
    stopAlarm();
    const next = { ...s, status:"idle", remainingMs:0, endsAt:null, totalMs:0 };
    save(next);
    try{ api.playSound("collapse"); }catch{}
  }
  function startTimer(){
    const s = load();
    const total = clamp(((s.h * 60 + s.m) * 60 + s.s) * 1000, 0, MAX_MS);
    if(total <= 0) return;
    stopAlarm();
    save({ ...s, open:true, status:"running", totalMs:total, remainingMs:total, endsAt:Date.now() + total });
    try{ api.playSound("expand"); }catch{}
  }
  function setInputs(patch){
    const s = load();
    if(s.status !== "idle") return;
    save({ ...s, ...patch });
  }

  const R = 80, CIRC = 2 * Math.PI * R;

  function Overlay(){
    const [snap, setSnap] = useTimerSync();
    const [, setNow] = useState(()=> Date.now());
    const panelRef = useRef(null);
    const dragRef = useRef(null);

    useEffect(()=>{
      const iv = window.setInterval(()=>{
        const cur = load();
        const rung = checkRing(cur);
        if(rung){ setSnap((prev)=> equal(prev, rung) ? prev : rung); return; }
        setSnap((prev)=> equal(prev, cur) ? prev : cur);
        if(cur.status === "running" || cur.status === "ringing") setNow(Date.now());
      }, 250);
      return ()=> window.clearInterval(iv);
    },[]);

    // clamp into viewport on window resize
    useEffect(()=>{
      const onResize = ()=>{
        setSnap((s)=>{
          const nx = clamp(s.geom.x, 0, Math.max(0, window.innerWidth - 200));
          const ny = clamp(s.geom.y, 0, Math.max(0, window.innerHeight - 80));
          if(nx === s.geom.x && ny === s.geom.y) return s;
          const next = { ...s, geom:{ x:nx, y:ny } };
          save(next, false);
          return next;
        });
      };
      window.addEventListener("resize", onResize);
      return ()=> window.removeEventListener("resize", onResize);
    },[]);

    // Escape hides — but ringing must be Stopped first
    useEffect(()=>{
      if(!snap.open) return;
      const key = (e)=>{
        if(e.key === "Escape" && snap.status !== "ringing"){
          const s = load(); s.open = false; save(s);
          setSnap(s);
          try{ api.playSound("collapse"); }catch{}
        }
        // Space = quick pause/resume when not typing
        if((e.key === " " || e.code === "Space") && (snap.status === "running" || snap.status === "paused")){
          const t = e.target;
          if(t && t.closest && t.closest("input, textarea, button, select")) return;
          e.preventDefault();
          if(snap.status === "running") pauseTimer(); else resumeTimer();
          setSnap(load());
        }
      };
      window.addEventListener("keydown", key);
      return ()=> window.removeEventListener("keydown", key);
    },[snap.open, snap.status]);

    if(!snap.open) return null;

    const now = Date.now();
    const rem = remainingOf(snap, now);
    const ringing = snap.status === "ringing";
    const frac = snap.totalMs > 0 ? clamp(rem / snap.totalMs, 0, 1) : 0;

    const closePanel = ()=>{
      if(ringing) return; // must Stop first
      const s = load(); s.open = false; save(s); setSnap(s);
      try{ api.playSound("collapse"); }catch{}
    };

    const onDragStart = (e)=>{
      if(e.button !== 0) return;
      if(e.target.closest("button, input")) return;
      e.preventDefault();
      const el = panelRef.current;
      if(!el) return;
      const startX = e.clientX, startY = e.clientY;
      const g0 = { ...snap.geom };
      dragRef.current = { startX, startY, g0 };
      document.body.style.userSelect = "none";
      let raf = 0;
      const last = { x:g0.x, y:g0.y };
      const flush = ()=>{
        raf = 0;
        el.style.left = last.x + "px";
        el.style.top = last.y + "px";
      };
      const move = (ev)=>{
        const d = dragRef.current; if(!d) return;
        last.x = clamp(d.g0.x + (ev.clientX - d.startX), 0, Math.max(0, window.innerWidth - 200));
        last.y = clamp(d.g0.y + (ev.clientY - d.startY), 0, Math.max(0, window.innerHeight - 80));
        if(!raf) raf = requestAnimationFrame(flush);
      };
      const up = ()=>{
        if(raf) cancelAnimationFrame(raf);
        el.style.left = last.x + "px";
        el.style.top = last.y + "px";
        setSnap((s)=>{
          if(s.geom.x === last.x && s.geom.y === last.y) return s;
          const next = { ...s, geom:{ x:last.x, y:last.y } };
          save(next, true);
          return next;
        });
        dragRef.current = null;
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    const numField = (k, max, label)=>{
      return h("label", { className:"timer-field" },
        h("input", {
          type:"number",
          className:"timer-num",
          min:0, max, step:1,
          value: String(snap[k]),
          disabled: snap.status !== "idle",
          "aria-label": label,
          onChange:(e)=>{
            const v = num(e.target.value, 0, 0, max);
            // cap hours so H:M:S never exceeds 24h
            if(k === "h" && v === 24) setInputs({ h:24, m:0, s:0 });
            else setInputs({ [k]: v });
            setSnap(load());
          },
        }),
        h("span", { className:"timer-field-cap" }, label)
      );
    };

    const ring = h("div", { className:`timer-face${ringing ? " ringing" : ""}${snap.status === "paused" ? " paused" : ""}` },
      h("svg", { className:"timer-ring", viewBox:"0 0 200 200", "aria-hidden":true },
        h("circle", { className:"timer-ring-track", cx:100, cy:100, r:R }),
        h("circle", {
          className:"timer-ring-prog",
          cx:100, cy:100, r:R,
          strokeDasharray: CIRC.toFixed(1),
          strokeDashoffset: (CIRC * (1 - frac)).toFixed(1),
        })
      ),
      h("div", { className:"timer-face-center" },
        h("div", { className:"timer-digits" }, fmt(rem)),
        snap.label ? h("div", { className:"timer-face-label" }, snap.label) : null,
        ringing ? h("div", { className:"timer-up" }, "Time's up") :
          snap.status === "paused" ? h("div", { className:"timer-state" }, "Paused") : null
      )
    );

    const controls = ringing
      ? h("button", {
          className:"timer-btn stop big", onClick:()=>{ stopTimer(); setSnap(load()); },
          autoFocus:true,
        }, h("i", { className:"fa-solid fa-stop" }), "Stop")
      : snap.status === "running"
        ? h("div", { className:"timer-row" },
            h("button", { className:"timer-btn pause", "data-tip":"Pause (Space)", onClick:()=>{ pauseTimer(); setSnap(load()); } },
              h("i", { className:"fa-solid fa-pause" }), "Pause"),
            h("button", { className:"timer-btn stop", "data-tip":"Stop and reset", onClick:()=>{ stopTimer(); setSnap(load()); } },
              h("i", { className:"fa-solid fa-stop" }), "Stop"))
        : snap.status === "paused"
          ? h("div", { className:"timer-row" },
              h("button", { className:"timer-btn resume", "data-tip":"Resume (Space)", onClick:()=>{ resumeTimer(); setSnap(load()); }, autoFocus:true },
                h("i", { className:"fa-solid fa-play" }), "Resume"),
              h("button", { className:"timer-btn stop", "data-tip":"Stop and reset", onClick:()=>{ stopTimer(); setSnap(load()); } },
                h("i", { className:"fa-solid fa-stop" }), "Stop"))
          : null;

    const setup = snap.status === "idle" ? h("div", { className:"timer-setup" },
      h("input", {
        className:"timer-label",
        placeholder:"Label (optional)",
        maxLength:80,
        value: snap.label,
        onChange:(e)=>{ setInputs({ label: e.target.value.slice(0, 80) }); setSnap(load()); },
      }),
      h("div", { className:"timer-inputs" },
        numField("h", 24, "hr"),
        h("span", { className:"timer-sep" }, ":"),
        numField("m", 59, "min"),
        h("span", { className:"timer-sep" }, ":"),
        numField("s", 59, "sec")
      ),
      h("div", { className:"timer-presets" },
        ...PRESETS.map((p)=>{
          const is = ((snap.h * 60 + snap.m) * 60 + snap.s) * 1000 === p.ms;
          return h("button", {
            key: p.label,
            className: `timer-preset${is ? " on" : ""}`,
            onClick: ()=>{
              const t = Math.floor(p.ms / 1000);
              setInputs({ h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 });
              setSnap(load());
              try{ api.playSound("click"); }catch{}
            },
          }, p.label);
        })
      ),
      h("button", {
        className:"timer-btn start big",
        disabled: ((snap.h * 60 + snap.m) * 60 + snap.s) <= 0,
        onClick: ()=>{ startTimer(); setSnap(load()); },
      }, h("i", { className:"fa-solid fa-play" }), "Start")
    ) : null;

    return h("div", {
      ref: panelRef,
      className: `timer-panel${ringing ? " ringing" : ""}`,
      style:{ left: snap.geom.x + "px", top: snap.geom.y + "px" },
    },
      h("div", { className:"timer-head", onMouseDown:onDragStart },
        h("span", { className:"timer-head-title" },
          h("i", { className:"fa-solid fa-stopwatch" }), "Timer"
        ),
        h("span", { style:{ flex:1 } }),
        h("button", {
          className:"icon-btn", "data-tip": ringing ? "Stop the timer first" : "Hide timer",
          onClick: closePanel, "aria-label":"Close",
        }, h("i", { className:"fa-solid fa-xmark" }))
      ),
      h("div", { className:"timer-body" }, ring, controls, setup)
    );
  }

  return {
    Titlebar: TitlebarBtn,
    Overlay,
    hotkeys: [
      { id:"toggle", default:"Alt+T", label:"toggle timer", description:"Show/hide floating timer" },
    ],
    onHotkey(id){
      if(id === "toggle") toggleTimer();
    },
    info:{ keys:[
      ["Alt+T / Timer (Titlebar)","Toggle floating timer — rebindable in Hotkeys"],
      ["Middle-click titlebar timer","Quick pause / resume"],
      ["Space (panel open)","Pause / resume"],
      ["Presets + H/M/S","Single 24h-max timer; Start replaces the current one"],
      ["Alarm","Loops until Stop — panel stays open while ringing"],
    ] },
  };
}
