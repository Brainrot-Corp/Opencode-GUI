// Notepad — floating resizable multi-tab scratch notes (plugin).
// Titlebar button + floating Overlay share localStorage "oc.notepad"
//   {tabs:{id,title,content}[], activeId, geom:{x,y,w,h}, open}
// Global save (not per-workspace), double-click tab to rename.

const ID = "notepad";
const KEY = "oc.notepad";
const MIN_W = 320, MIN_H = 220, MAX_W = 900, MAX_H = 700;

function clamp(n, a, b){ return Math.min(Math.max(n, a), b); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function defaultGeom(){
  const w = 560, h = 380;
  const x = Math.max(12, Math.floor((window.innerWidth - w) / 2));
  const y = Math.max(12, Math.floor((window.innerHeight - h) / 2 - 20));
  return { x, y, w, h };
}

function load(){
  try{
    const raw = localStorage.getItem(KEY);
    if(!raw) return { tabs:[{id:"1", title:"Note 1", content:""}], activeId:"1", geom:defaultGeom(), open:false };
    const p = JSON.parse(raw);
    const tabs = Array.isArray(p.tabs) && p.tabs.length ? p.tabs.map(t=>({
      id: String(t.id||uid()),
      title: String(t.title||"Note").slice(0,40) || "Note",
      content: String(t.content||"")
    })) : [{id:"1", title:"Note 1", content:""}];
    const ids = new Set(tabs.map(t=>t.id));
    const activeId = ids.has(String(p.activeId)) ? String(p.activeId) : tabs[0].id;
    let geom = p.geom && typeof p.geom === "object" ? p.geom : defaultGeom();
    const vw = window.innerWidth, vh = window.innerHeight;
    geom = {
      x: clamp(Number(geom.x)||0, 0, Math.max(0, vw - MIN_W)),
      y: clamp(Number(geom.y)||0, 0, Math.max(0, vh - MIN_H)),
      w: clamp(Number(geom.w)||560, MIN_W, Math.min(MAX_W, vw - 12)),
      h: clamp(Number(geom.h)||380, MIN_H, Math.min(MAX_H, vh - 12)),
    };
    return { tabs, activeId, geom, open: !!p.open };
  }catch{ return { tabs:[{id:"1", title:"Note 1", content:""}], activeId:"1", geom:defaultGeom(), open:false }; }
}

function save(state){
  try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch{}
  try{ window.dispatchEvent(new CustomEvent("oc:notepad:changed")); }catch{}
}

export default function activate(api){
  const { h, useState, useEffect, useRef } = api;

  function TitlebarBtn(){
    const [open, setOpen] = useState(()=> load().open);
    useEffect(()=>{
      const sync = ()=> setOpen(load().open);
      window.addEventListener("oc:notepad:changed", sync);
      window.addEventListener("storage", sync);
      return ()=>{ window.removeEventListener("oc:notepad:changed", sync); window.removeEventListener("storage", sync); };
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
      "data-tip": open ? "Hide notepad" : "Show notepad",
      "aria-pressed": open,
      onClick: toggle
    }, h("i", { className:"fa-solid fa-note-sticky" }));
  }

  function Overlay(){
    const [state, setState] = useState(()=> load());
    const [renaming, setRenaming] = useState(null);
    const [draftName, setDraftName] = useState("");
    const taRef = useRef(null);
    const panelRef = useRef(null);
    const dragRef = useRef(null);
    const resizeRef = useRef(null);

    // sync from external toggle / other panel instance / storage
    useEffect(()=>{
      const sync = ()=> setState(load());
      window.addEventListener("oc:notepad:changed", sync);
      window.addEventListener("storage", sync);
      return ()=>{ window.removeEventListener("oc:notepad:changed", sync); window.removeEventListener("storage", sync); };
    },[]);

    // persist on every state change
    const stateRef = useRef(state);
    stateRef.current = state;
    useEffect(()=>{ save(state); }, [state]);

    // clamp geom into viewport on window resize
    useEffect(()=>{
      const onResize = ()=>{
        const vw = window.innerWidth, vh = window.innerHeight;
        setState(s=>{
          const g = s.geom;
          const nx = clamp(g.x, 0, Math.max(0, vw - MIN_W));
          const ny = clamp(g.y, 0, Math.max(0, vh - MIN_H));
          const nw = clamp(g.w, MIN_W, Math.min(MAX_W, vw - 12));
          const nh = clamp(g.h, MIN_H, Math.min(MAX_H, vh - 12));
          if(nx===g.x && ny===g.y && nw===g.w && nh===g.h) return s;
          return { ...s, geom:{x:nx, y:ny, w:nw, h:nh} };
        });
      };
      window.addEventListener("resize", onResize);
      return ()=> window.removeEventListener("resize", onResize);
    },[]);

    // Escape closes panel
    useEffect(()=>{
      if(!state.open) return;
      const key = (e)=>{
        if(e.key==="Escape" && !renaming){
          const s = load(); s.open=false; save(s); setState(s);
          try{ api.playSound("collapse"); }catch{}
        }
      };
      window.addEventListener("keydown", key);
      return ()=> window.removeEventListener("keydown", key);
    }, [state.open, renaming]);

    // focus textarea when opening or switching tab
    useEffect(()=>{
      if(state.open) setTimeout(()=> taRef.current?.focus(), 0);
    }, [state.open, state.activeId]);

    if(!state.open) return null;

    const active = state.tabs.find(t=>t.id===state.activeId) || state.tabs[0];
    const geom = state.geom;

    const setActive = (id)=> setState(s=> ({...s, activeId:id}));

    const updateContent = (v)=> setState(s=>{
      const tabs = s.tabs.map(t=> t.id===s.activeId ? {...t, content:v} : t);
      return {...s, tabs};
    });

    const addTab = ()=>{
      const id = uid();
      const n = state.tabs.length + 1;
      const title = `Note ${n}`;
      setState(s=> ({...s, tabs:[...s.tabs, {id, title, content:""}], activeId:id}));
      setRenaming(id); setDraftName(title);
      try{ api.playSound("expand"); }catch{}
    };

    const closeTab = (id, e)=>{
      if(e) e.stopPropagation();
      setState(s=>{
        if(s.tabs.length===1){
          // never delete last tab — clear it
          const tabs = [{...s.tabs[0], content:""}];
          return {...s, tabs, activeId: tabs[0].id};
        }
        const idx = s.tabs.findIndex(t=>t.id===id);
        const tabs = s.tabs.filter(t=>t.id!==id);
        let activeId = s.activeId;
        if(activeId===id){
          const at = Math.min(idx, tabs.length-1);
          activeId = tabs[Math.max(0,at)].id;
        }
        return {...s, tabs, activeId};
      });
      if(renaming===id){ setRenaming(null); }
    };

    const startRename = (id, title)=>{
      setRenaming(id); setDraftName(title);
      setTimeout(()=>{
        const el = document.querySelector(`.notepad-rename[data-id="${id}"]`);
        if(el){ el.focus(); el.select(); }
      },0);
    };
    const commitRename = ()=>{
      const id = renaming;
      if(!id) return;
      const t = draftName.trim();
      if(t) setState(s=> ({...s, tabs: s.tabs.map(x=> x.id===id ? {...x, title:t.slice(0,40)} : x)}));
      setRenaming(null);
    };
    const cancelRename = ()=> setRenaming(null);

    const closePanel = ()=>{
      const s = {...stateRef.current, open:false};
      save(s); setState(s);
      try{ api.playSound("collapse"); }catch{}
    };

    // drag header
    const onDragStart = (e)=>{
      if(e.button!==0) return;
      if(e.target.closest("button, input")) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const g0 = {...geom};
      dragRef.current = { startX, startY, g0 };
      document.body.style.userSelect="none";
      const move = (ev)=>{
        const d = dragRef.current; if(!d) return;
        const nx = clamp(d.g0.x + (ev.clientX - d.startX), 0, Math.max(0, window.innerWidth - g0.w));
        const ny = clamp(d.g0.y + (ev.clientY - d.startY), 0, Math.max(0, window.innerHeight - 80));
        setState(s=> ({...s, geom:{...s.geom, x:nx, y:ny}}));
      };
      const up = ()=>{
        dragRef.current=null;
        document.body.style.userSelect="";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    // resize helper dir: "n","s","e","w","nw","ne","sw","se"
    const onResizeStart = (dir)=>(e)=>{
      if(e.button!==0) return;
      e.preventDefault(); e.stopPropagation();
      const sx=e.clientX, sy=e.clientY;
      const g0={...geom};
      resizeRef.current={dir, sx, sy, g0};
      document.body.style.userSelect="none";
      const move=(ev)=>{
        const r=resizeRef.current; if(!r) return;
        let {x,y,w,h}=r.g0;
        const dx=ev.clientX - r.sx, dy=ev.clientY - r.sy;
        if(r.dir.includes("e")) w = clamp(g0.w + dx, MIN_W, Math.min(MAX_W, window.innerWidth - x - 6));
        if(r.dir.includes("s")) h = clamp(g0.h + dy, MIN_H, Math.min(MAX_H, window.innerHeight - y - 6));
        if(r.dir.includes("w")){ const nw=clamp(g0.w - dx, MIN_W, g0.x + g0.w); x = g0.x + g0.w - nw; w=nw; x=clamp(x,0,window.innerWidth - MIN_W); }
        if(r.dir.includes("n")){ const nh=clamp(g0.h - dy, MIN_H, g0.y + g0.h); y = g0.y + g0.h - nh; h=nh; y=clamp(y,0,window.innerHeight - MIN_H); }
        setState(s=> ({...s, geom:{x,y,w,h}}));
      };
      const up=()=>{
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
      className:"notepad-panel",
      style:{ left: geom.x+"px", top: geom.y+"px", width: geom.w+"px", height: geom.h+"px" },
      onMouseDown:(e)=>{ if(e.target.closest("button, input, textarea")) return; },
    },
      h("div", { className:"notepad-head", onMouseDown:onDragStart },
        h("span", { className:"notepad-head-title" }, "Notepad"),
        h("div", { className:"notepad-tabs" },
          ...state.tabs.map(t=>{
            const isActive = t.id===state.activeId;
            if(renaming===t.id){
              return h("input", {
                key:t.id,
                "data-id":t.id,
                className:"notepad-rename",
                value: draftName,
                autoFocus:true,
                onChange:(e)=> setDraftName(e.target.value),
                onKeyDown:(e)=>{
                  if(e.key==="Enter"){ e.preventDefault(); commitRename(); }
                  else if(e.key==="Escape"){ e.preventDefault(); cancelRename(); }
                },
                onBlur: commitRename,
              });
            }
            return h("button", {
              key:t.id,
              className:"notepad-tab"+(isActive?" on":""),
              onClick:()=> setActive(t.id),
              onDoubleClick:()=> startRename(t.id, t.title),
              "data-tip":"Double-click to rename",
              title:"Double-click to rename"
            },
              h("span", {className:"notepad-tab-label"}, t.title),
              h("button", {
                className:"notepad-tab-x",
                "data-tip":"Close tab",
                onClick:(e)=> closeTab(t.id, e),
                "aria-label":"Close tab"
              }, h("i", {className:"fa-solid fa-xmark"}))
            );
          }),
          h("button", { className:"notepad-add", "data-tip":"New tab", onClick:addTab, "aria-label":"New tab" }, h("i", {className:"fa-solid fa-plus"}))
        ),
        h("button", { className:"icon-btn", "data-tip":"Close notepad", onClick:closePanel, "aria-label":"Close" }, h("i", {className:"fa-solid fa-xmark"}))
      ),
      h("div", { className:"notepad-body" },
        h("textarea", {
          ref: taRef,
          className:"notepad-ta",
          value: active ? active.content : "",
          placeholder:"Scratch notes…",
          spellCheck:false,
          onChange:(e)=> updateContent(e.target.value)
        })
      ),
      h("div", { className:"notepad-handle n", onMouseDown:onResizeStart("n") }),
      h("div", { className:"notepad-handle s", onMouseDown:onResizeStart("s") }),
      h("div", { className:"notepad-handle e", onMouseDown:onResizeStart("e") }),
      h("div", { className:"notepad-handle w", onMouseDown:onResizeStart("w") }),
      h("div", { className:"notepad-handle nw", onMouseDown:onResizeStart("nw") }),
      h("div", { className:"notepad-handle ne", onMouseDown:onResizeStart("ne") }),
      h("div", { className:"notepad-handle sw", onMouseDown:onResizeStart("sw") }),
      h("div", { className:"notepad-handle se", onMouseDown:onResizeStart("se") })
    );
  }

  return {
    Titlebar: TitlebarBtn,
    Overlay: Overlay,
    info:{ keys:[["Notepad (Titlebar)","Toggle floating notepad (sticky-note icon) — Titlebar only"]] }
  };
}
