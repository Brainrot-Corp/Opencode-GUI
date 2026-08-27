// TikTok — floating persistent TikTok-only webview (plugin).
// Titlebar button + floating panel (drag/resize) hosts a Tauri child webview
// at the panel's content rect. Rust enforces tiktok.com allowlist + persistent session.

const ID = "tiktok";
const KEY = "oc.tiktok";
const TIKTOK_URL = "https://www.tiktok.com";
const MIN_W = 280, MIN_H = 350, MAX_W = 1200, MAX_H = 1200;
const DEF_W = 380, DEF_H = 680; // phone 9:16, but freely resizable up to viewport

function clamp(n, a, b){ return Math.min(Math.max(n, a), b); }

function defaultGeom(){
  const w = DEF_W, h = DEF_H;
  const x = Math.max(8, Math.floor((window.innerWidth - w) / 2));
  const y = Math.max(8, Math.floor((window.innerHeight - h) / 2 - 10));
  return { x, y, w, h };
}

function load(){
  try{
    const raw = localStorage.getItem(KEY);
    if(!raw) return { open:false, geom: defaultGeom() };
    const p = JSON.parse(raw);
    let geom = p.geom && typeof p.geom === "object" ? p.geom : defaultGeom();
    const vw = window.innerWidth, vh = window.innerHeight;
    geom = {
      x: clamp(Number(geom.x)||0, 0, Math.max(0, vw - MIN_W)),
      y: clamp(Number(geom.y)||0, 0, Math.max(0, vh - MIN_H)),
      w: clamp(Number(geom.w)||DEF_W, MIN_W, Math.min(MAX_W, vw - 8)),
      h: clamp(Number(geom.h)||DEF_H, MIN_H, Math.min(MAX_H, vh - 8)),
    };
    return { open: !!p.open, geom };
  }catch{ return { open:false, geom: defaultGeom() }; }
}

function save(state){
  try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch{}
  try{ window.dispatchEvent(new CustomEvent("oc:tiktok:changed")); }catch{}
}
function equal(a,b){ try{ return JSON.stringify(a)===JSON.stringify(b);}catch{return false;} }

export default function activate(api){
  const { h, useState, useEffect, useRef } = api;

  function TitlebarBtn(){
    const [open, setOpen] = useState(()=> load().open);
    useEffect(()=>{
      const sync = ()=> setOpen(load().open);
      window.addEventListener("oc:tiktok:changed", sync);
      window.addEventListener("storage", sync);
      return ()=>{ window.removeEventListener("oc:tiktok:changed", sync); window.removeEventListener("storage", sync); };
    },[]);
    const toggle = ()=>{
      const s = load();
      s.open = !s.open;
      save(s);
      setOpen(s.open);
      try{ api.playSound(s.open ? "expand" : "collapse"); }catch{}
    };
    return h("button", {
      className: `icon-btn${open ? " on" : ""}`,
      "data-tip": open ? "Hide TikTok" : "Show TikTok",
      "aria-pressed": open,
      onClick: toggle
    }, h("i", { className:"fa-brands fa-tiktok" }));
  }

  function Overlay(){
    const [state, setState] = useState(()=> load());
    const panelRef = useRef(null);
    const dragRef = useRef(null);
    const resizeRef = useRef(null);
    const headerH = 36; // must match measured header height for webview y-offset
    const [blocked, setBlocked] = useState("");

    // sync external toggle
    useEffect(()=>{
      const sync = ()=>{
        const next = load();
        setState(prev=> equal(prev,next) ? prev : next);
      };
      window.addEventListener("oc:tiktok:changed", sync);
      window.addEventListener("storage", sync);
      return ()=>{ window.removeEventListener("oc:tiktok:changed", sync); window.removeEventListener("storage", sync); };
    },[]);

    // listen for blocked nav
    useEffect(()=>{
      let un;
      // tauri listen is global via window.__TAURI__ but we use api.invoke listen helper if available
      // fallback to window event emitted by Rust? Rust emits "tiktok://blocked"
      // Use Tauri event listen if present
      try{
        const { listen } = window.__TAURI__?.event || {};
        if(listen){
          listen("tiktok://blocked", (e)=>{
            const url = e?.payload?.url || "";
            setBlocked(url ? `Blocked: ${url.slice(0,80)}` : "Navigation outside TikTok blocked");
            setTimeout(()=> setBlocked(""), 2500);
          }).then(f=>{ un=f; });
        }
      }catch{}
      return ()=>{ try{ un && un(); }catch{} };
    },[]);

    // open/close the child webview based on state.open + geom — no save here (persistence is explicit in drag/resize/close handlers)
    const lastOpen = useRef(state.open);
    const lastGeom = useRef(state.geom);
    useEffect(()=>{
      const { open, geom } = state;
      const x = geom.x;
      const y = geom.y + headerH;
      const w = geom.w;
      const h = Math.max(120, geom.h - headerH);
      const geomChanged = !equal(geom, lastGeom.current);

      if(open && !lastOpen.current){
        lastOpen.current = true;
        lastGeom.current = geom;
        api.invoke("tiktok_open", { url: TIKTOK_URL, x, y, w, h }).catch(()=>{});
      } else if(!open && lastOpen.current){
        lastOpen.current = false;
        lastGeom.current = geom;
        api.invoke("tiktok_close").catch(()=>{});
      } else if(open && lastOpen.current && geomChanged){
        lastGeom.current = geom;
        api.invoke("tiktok_set_bounds", { x, y, w, h }).catch(()=>{});
      } else {
        lastGeom.current = geom;
      }
    }, [state.open, state.geom.x, state.geom.y, state.geom.w, state.geom.h]);

    // ensure close on unmount
    useEffect(()=> ()=>{ if(lastOpen.current) api.invoke("tiktok_close").catch(()=>{}); }, []);

    // keep webview aligned on window resize (main window resize) — clamp panel inside viewport
    useEffect(()=>{
      if(!state.open) return;
      const onResize = ()=>{
        const vw = window.innerWidth, vh = window.innerHeight;
        setState(s=>{
          const g = s.geom;
          const nx = clamp(g.x, 0, Math.max(0, vw - MIN_W));
          const ny = clamp(g.y, 0, Math.max(0, vh - MIN_H));
          const nw = clamp(g.w, MIN_W, Math.min(MAX_W, vw - 8));
          const nh = clamp(g.h, MIN_H, Math.min(MAX_H, vh - 8));
          if(nx===g.x && ny===g.y && nw===g.w && nh===g.h) return s;
          const next = { ...s, geom:{x:nx, y:ny, w:nw, h:nh} };
          save(next);
          return next;
        });
      };
      window.addEventListener("resize", onResize);
      return ()=> window.removeEventListener("resize", onResize);
    }, [state.open]);

    // Escape closes
    useEffect(()=>{
      if(!state.open) return;
      const key=(e)=>{
        if(e.key==="Escape"){
          const s = load(); s.open=false; save(s); setState(s);
          try{ api.playSound("collapse"); }catch{}
        }
      };
      window.addEventListener("keydown", key);
      return ()=> window.removeEventListener("keydown", key);
    }, [state.open]);

    if(!state.open) return null;

    const geom = state.geom;

    const closePanel = ()=>{
      const s = {...state, open:false};
      save(s); setState(s);
      try{ api.playSound("collapse"); }catch{}
    };

    const onDragStart = (e)=>{
      if(e.button!==0) return;
      if(e.target.closest("button, input")) return;
      e.preventDefault();
      const el = panelRef.current;
      if(!el) return;
      const startX=e.clientX, startY=e.clientY;
      const g0={...geom};
      dragRef.current={startX,startY,g0};
      document.body.style.userSelect="none";
      let raf=0, last={x:g0.x, y:g0.y};
      const flush=()=>{
        raf=0;
        el.style.left=last.x+"px";
        el.style.top=last.y+"px";
        const x=last.x, y=last.y + headerH, w=g0.w, h=Math.max(120,g0.h-headerH);
        api.invoke("tiktok_set_bounds", { x, y, w, h }).catch(()=>{});
      };
      const move=(ev)=>{
        const d=dragRef.current; if(!d) return;
        last.x=clamp(d.g0.x + (ev.clientX - d.startX), 0, Math.max(0, window.innerWidth - g0.w));
        last.y=clamp(d.g0.y + (ev.clientY - d.startY), 0, Math.max(0, window.innerHeight - 80));
        if(!raf) raf=requestAnimationFrame(flush);
      };
      const up=()=>{
        if(raf) cancelAnimationFrame(raf);
        el.style.left=last.x+"px"; el.style.top=last.y+"px";
        const x=last.x, y=last.y + headerH;
        api.invoke("tiktok_set_bounds", { x, y, w:g0.w, h:Math.max(120,g0.h-headerH) }).catch(()=>{});
        setState(s=>{
          if(s.geom.x===last.x && s.geom.y===last.y) return s;
          const next={...s, geom:{...s.geom, x:last.x, y:last.y}};
          save(next);
          return next;
        });
        dragRef.current=null;
        document.body.style.userSelect="";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    const onResizeStart=(dir)=>(e)=>{
      if(e.button!==0) return;
      e.preventDefault(); e.stopPropagation();
      const el=panelRef.current; if(!el) return;
      const sx=e.clientX, sy=e.clientY;
      const g0={...geom};
      resizeRef.current={dir,sx,sy,g0};
      document.body.style.userSelect="none";
      let raf=0, last={...g0};
      const flush=()=>{
        raf=0;
        el.style.left=last.x+"px"; el.style.top=last.y+"px";
        el.style.width=last.w+"px"; el.style.height=last.h+"px";
        const x=last.x, y=last.y + headerH, w=last.w, h=Math.max(120,last.h-headerH);
        api.invoke("tiktok_set_bounds", { x, y, w, h }).catch(()=>{});
      };
      const move=(ev)=>{
        const r=resizeRef.current; if(!r) return;
        let {x,y,w,h}=r.g0;
        const dx=ev.clientX - r.sx, dy=ev.clientY - r.sy;
        if(r.dir.includes("e")) w=clamp(g0.w+dx, MIN_W, Math.min(MAX_W, window.innerWidth - x - 6));
        if(r.dir.includes("s")) h=clamp(g0.h+dy, MIN_H, Math.min(MAX_H, window.innerHeight - y - 6));
        if(r.dir.includes("w")){ const nw=clamp(g0.w - dx, MIN_W, g0.x + g0.w); x=g0.x + g0.w - nw; w=nw; x=clamp(x,0,window.innerWidth - MIN_W); }
        if(r.dir.includes("n")){ const nh=clamp(g0.h - dy, MIN_H, g0.y + g0.h); y=g0.y + g0.h - nh; h=nh; y=clamp(y,0,window.innerHeight - MIN_H); }
        last={x,y,w,h};
        if(!raf) raf=requestAnimationFrame(flush);
      };
      const up=()=>{
        if(raf) cancelAnimationFrame(raf);
        el.style.left=last.x+"px"; el.style.top=last.y+"px";
        el.style.width=last.w+"px"; el.style.height=last.h+"px";
        const x=last.x, y=last.y + headerH, w=last.w, h=Math.max(120,last.h-headerH);
        api.invoke("tiktok_set_bounds", { x, y, w, h }).catch(()=>{});
        setState(s=>{
          if(equal(s.geom,last)) return s;
          const next={...s, geom:last};
          save(next);
          return next;
        });
        resizeRef.current=null;
        document.body.style.userSelect="";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    return h("div", {
      ref: panelRef,
      className:"tiktok-panel",
      style:{ left: geom.x+"px", top: geom.y+"px", width: geom.w+"px", height: geom.h+"px" },
    },
      h("div", { className:"tiktok-head", onMouseDown:onDragStart },
        h("span", { className:"tiktok-head-title" },
          h("i", { className:"fa-brands fa-tiktok" }),
          "TikTok"
        ),
        h("span", { style:{flex:1}}),
        h("div", { className:"tiktok-toolbar" },
          h("button", { className:"icon-btn", "data-tip":"Reload", onClick:()=> api.invoke("tiktok_navigate", {url:TIKTOK_URL}).catch(()=>{}) }, h("i", {className:"fa-solid fa-rotate-right"})),
          h("button", { className:"icon-btn", "data-tip":"Open in system browser", onClick:()=> api.invoke("open_external", {url:TIKTOK_URL}).catch(()=>{}) }, h("i", {className:"fa-solid fa-up-right-from-square"})),
          h("button", { className:"icon-btn", "data-tip":"Close TikTok", onClick:closePanel, "aria-label":"Close" }, h("i", {className:"fa-solid fa-xmark"}))
        )
      ),
      h("div", { className:"tiktok-body" },
        h("div", { className:"tiktok-hole" }),
        blocked ? h("div", { className:"tiktok-hint", style:{background:"rgba(0,0,0,.55)", color:"var(--text)", zIndex:2}}, blocked) : null
      ),
      h("div", { className:"tiktok-handle n", onMouseDown:onResizeStart("n") }),
      h("div", { className:"tiktok-handle s", onMouseDown:onResizeStart("s") }),
      h("div", { className:"tiktok-handle e", onMouseDown:onResizeStart("e") }),
      h("div", { className:"tiktok-handle w", onMouseDown:onResizeStart("w") }),
      h("div", { className:"tiktok-handle nw", onMouseDown:onResizeStart("nw") }),
      h("div", { className:"tiktok-handle ne", onMouseDown:onResizeStart("ne") }),
      h("div", { className:"tiktok-handle sw", onMouseDown:onResizeStart("sw") }),
      h("div", { className:"tiktok-handle se", onMouseDown:onResizeStart("se") })
    );
  }

  return {
    Titlebar: TitlebarBtn,
    Overlay: Overlay,
    info:{ keys:[["TikTok (Titlebar)","Toggle floating TikTok — TikTok icon in titlebar"]] }
  };
}
