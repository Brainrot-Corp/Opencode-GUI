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

function save(state, notify=true){
  try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch{}
  if(notify) try{ window.dispatchEvent(new CustomEvent("oc:notepad:changed")); }catch{}
}
// fast compare to avoid feedback loops
function equal(a,b){ try{ return JSON.stringify(a)===JSON.stringify(b); }catch{ return false; } }

// ---- VS Code line ops (mirrors src/lib/editorKeys.ts) — plain JS copy for the plugin sandbox ----
function npGetLineAt(text, pos){
  const p = Math.max(0, Math.min(pos, text.length));
  const start = text.lastIndexOf("\n", p - 1) + 1;
  const nl = text.indexOf("\n", p);
  const end = nl === -1 ? text.length : nl;
  const endWithNl = nl === -1 ? text.length : nl + 1;
  return { start, end, endWithNl };
}
function npGetBlockRange(text, a, b){
  const lo = Math.min(a,b), hi = Math.max(a,b);
  if(lo===hi){ const r=npGetLineAt(text,lo); return { start:r.start, end:r.end, endWithNl:r.endWithNl }; }
  const r0=npGetLineAt(text,lo);
  const r1=npGetLineAt(text, hi-1);
  return { start:r0.start, end:r1.end, endWithNl:r1.endWithNl };
}
function npCopyToClipboard(text){
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){ void navigator.clipboard.writeText(text); return; }
  }catch{}
  try{
    const ta=document.createElement("textarea");
    ta.value=text; ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }catch{}
}
function npOpCopyLine(text,pos){ const {start,endWithNl}=npGetLineAt(text,pos); return text.slice(start,endWithNl); }
function npOpCutLine(text,pos){ const {start,endWithNl}=npGetLineAt(text,pos); return { text:text.slice(0,start)+text.slice(endWithNl), caret:start }; }
function npOpDeleteLine(text,a,b){
  const {start,endWithNl}=npGetBlockRange(text,a,b);
  if(start===0&&endWithNl===text.length) return { text:"", caret:0 };
  return { text:text.slice(0,start)+text.slice(endWithNl), caret:Math.min(start,text.length) };
}
function npOpDuplicate(text,a,b,dir){
  const {start,end,endWithNl}=npGetBlockRange(text,a,b);
  const hasNl=endWithNl>end;
  const block=hasNl?text.slice(start,endWithNl):text.slice(start,end);
  if(!block) return { text, caret:a };
  if(!hasNl){
    if(dir==="down"){
      const nt=text.slice(0,end)+"\n"+block+text.slice(end);
      const caret=end+1+(a-start);
      return { text:nt, caret };
    } else {
      const nt=text.slice(0,start)+block+"\n"+text.slice(start);
      const caret=start+(a-start);
      return { text:nt, caret };
    }
  }
  if(dir==="down"){
    const nt=text.slice(0,endWithNl)+block+text.slice(endWithNl);
    const caret=endWithNl + (a - start);
    return { text:nt, caret };
  } else {
    const nt=text.slice(0,start)+block+text.slice(start);
    const caret=start + (a - start);
    return { text:nt, caret };
  }
}
function npOpMoveLine(text,a,b,dir){
  const {start,end}=npGetBlockRange(text,a,b);
  const startLine=(text.slice(0,start).match(/\n/g)||[]).length;
  const endLine=(text.slice(0,end).match(/\n/g)||[]).length;
  const lines=text.split("\n");
  const count=endLine-startLine+1;
  if(dir==="down"){
    if(endLine>=lines.length-1) return null;
    const nextLine=lines[endLine+1];
    const block=lines.splice(startLine,count);
    lines.splice(startLine+1,0,...block);
    const nt=lines.join("\n");
    const caret=a + nextLine.length + 1;
    return { text:nt, caret:Math.min(caret,nt.length) };
  } else {
    if(startLine===0) return null;
    const prevLine=lines[startLine-1];
    const block=lines.splice(startLine,count);
    lines.splice(startLine-1,0,...block);
    const nt=lines.join("\n");
    const caret=a - (prevLine.length + 1);
    return { text:nt, caret:Math.max(0,caret) };
  }
}
function npOpSelectLine(text,pos){ const {start,end}=npGetLineAt(text,pos); return { start,end }; }
function npOpInsertLine(text,pos,dir){
  const {start,endWithNl}=npGetLineAt(text,pos);
  if(dir==="below"){
    const insAt=endWithNl;
    return { text:text.slice(0,insAt)+"\n"+text.slice(insAt), caret:insAt };
  } else {
    return { text:text.slice(0,start)+"\n"+text.slice(start), caret:start };
  }
}
function npOpToggleComment(text,a,b){
  const {start,endWithNl}=npGetBlockRange(text,a,b);
  const block=text.slice(start,endWithNl);
  const hasNl=block.endsWith("\n");
  const lines=block.split("\n");
  const raw=hasNl?lines.slice(0,-1):lines;
  const prefix="//";
  const nonEmpty=raw.filter(l=>l.trim().length>0);
  const all=nonEmpty.length>0 && nonEmpty.every(l=>l.trimStart().startsWith(prefix));
  const out=raw.map(l=>{
    if(l.trim().length===0) return l;
    const indentLen=l.length-l.trimStart().length;
    const indent=l.slice(0,indentLen);
    const rest=l.slice(indentLen);
    if(all){
      if(rest.startsWith(prefix+" ")) return indent+rest.slice(prefix.length+1);
      if(rest.startsWith(prefix)) return indent+rest.slice(prefix.length);
      return l;
    } else {
      return indent+prefix+" "+rest;
    }
  });
  let newBlock=out.join("\n");
  if(hasNl) newBlock+="\n";
  const nt=text.slice(0,start)+newBlock+text.slice(endWithNl);
  const caret=Math.min(start,nt.length);
  const selEnd=caret + newBlock.length - (hasNl?1:0);
  return { text:nt, caret, selEnd };
}

export default function activate(api){
  const { h, useState, useEffect, useRef } = api;

  function TitlebarBtn(){
    const [open, setOpen] = useState(()=> load().open);
    const [binding, setBinding] = useState(()=>{
      try{
        const s=api.settings();
        const ph=s.pluginHotkeys||{};
        const v=ph["notepad:toggle"];
        if(v===null) return null;
        if(typeof v==="string" && v) return v;
        return "Alt+N";
      }catch{ return "Alt+N"; }
    });
    useEffect(()=>{
      const sync = ()=> {
        setOpen(load().open);
        try{
          const s=api.settings();
          const ph=s.pluginHotkeys||{};
          const v=ph["notepad:toggle"];
          setBinding(v===null?null:(typeof v==="string"&&v?v:"Alt+N"));
        }catch{}
      };
      window.addEventListener("oc:notepad:changed", sync);
      window.addEventListener("storage", sync);
      // also listen for settings changes (hotkey rebind)
      const onSettings = ()=> sync();
      window.addEventListener("storage", onSettings);
      // custom event when settings updated? use interval fallback via storage
      return ()=>{ window.removeEventListener("oc:notepad:changed", sync); window.removeEventListener("storage", sync); window.removeEventListener("storage", onSettings); };
    },[]);
    const toggle = ()=>{
      const s = load();
      s.open = !s.open;
      save(s);
      setOpen(s.open);
      try{ api.playSound(s.open ? "expand" : "collapse"); }catch{}
    };
    const tip = binding ? `${open ? "Hide" : "Show"} notepad (${binding})` : (open ? "Hide notepad" : "Show notepad");
    return h("button", {
      className: `icon-btn${open ? " on" : ""}`,
      "data-tip": tip,
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
    // debounce content writes — typing stays in React state, localStorage after idle
    const saveTimer = useRef(0);
    const pendingRef = useRef(null);
    const historyRef = useRef([]);
    const futureRef = useRef([]);
    const isUndoRedoRef = useRef(false);

    // sync from external toggle / other panel instance / storage — ignore if equal to avoid feedback loop
    useEffect(()=>{
      const sync = ()=>{
        const next = load();
        setState(prev=> equal(prev, next) ? prev : next);
      };
      window.addEventListener("oc:notepad:changed", sync);
      window.addEventListener("storage", sync);
      return ()=>{ window.removeEventListener("oc:notepad:changed", sync); window.removeEventListener("storage", sync); };
    },[]);

    // persist helper for non-typing changes (tabs/geom/open/active)
    const stateRef = useRef(state);
    stateRef.current = state;
    const persist = (next, notify=true)=>{
      save(next, notify);
    };
    const apply = (updater, notify=true)=>{
      setState(prev=>{
        const next = typeof updater==="function" ? updater(prev) : updater;
        if(equal(prev, next)) return prev;
        // for typing we defer notify, for structural changes notify immediately
        if(notify) save(next, true);
        else {
          // schedule debounced save without notifying Titlebar
          pendingRef.current = next;
          clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(()=>{
            const p = pendingRef.current;
            if(p) { save(p, false); pendingRef.current=null; }
          }, 400);
        }
        return next;
      });
    };
    // flush pending content on unmount/hide
    useEffect(()=> ()=>{ if(pendingRef.current){ save(pendingRef.current, false); pendingRef.current=null; clearTimeout(saveTimer.current); } },[]);

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
          const next = { ...s, geom:{x:nx, y:ny, w:nw, h:nh} };
          save(next, false);
          return next;
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
          if(pendingRef.current){ save(pendingRef.current, false); pendingRef.current=null; clearTimeout(saveTimer.current); }
          const s = load(); s.open=false; save(s, true); setState(s);
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

    const setActive = (id)=> {
      // switching tabs resets undo history for the tab
      historyRef.current = [];
      futureRef.current = [];
      apply(s=> ({...s, activeId:id}), true);
    };

    const updateContent = (v)=> {
      const cur = stateRef.current.tabs.find(t=>t.id===stateRef.current.activeId)?.content ?? "";
      if (!isUndoRedoRef.current && v !== cur) {
        historyRef.current.push(cur);
        if (historyRef.current.length > 200) historyRef.current.shift();
        futureRef.current = [];
      }
      apply(s=>{
        const tabs = s.tabs.map(t=> t.id===s.activeId ? {...t, content:v} : t);
        return {...s, tabs};
      }, false);
    };

    const undoNotepad = ()=>{
      const h = historyRef.current;
      if (!h.length) return false;
      const cur = stateRef.current.tabs.find(t=>t.id===stateRef.current.activeId)?.content ?? "";
      const prev = h.pop();
      futureRef.current.push(cur);
      isUndoRedoRef.current = true;
      updateContent(prev);
      requestAnimationFrame(()=>{
        isUndoRedoRef.current = false;
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          try { const p = Math.min(ta.selectionStart ?? 0, prev.length); ta.setSelectionRange(p,p); } catch {}
        }
      });
      return true;
    };
    const redoNotepad = ()=>{
      const f = futureRef.current;
      if (!f.length) return false;
      const cur = stateRef.current.tabs.find(t=>t.id===stateRef.current.activeId)?.content ?? "";
      const next = f.pop();
      historyRef.current.push(cur);
      isUndoRedoRef.current = true;
      updateContent(next);
      requestAnimationFrame(()=>{
        isUndoRedoRef.current = false;
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          try { const p = Math.min(ta.selectionStart ?? 0, next.length); ta.setSelectionRange(p,p); } catch {}
        }
      });
      return true;
    };

    const onNotepadKeyDown = (e)=>{
      const ta = e.currentTarget;
      const text = ta.value;
      const hasSel = ta.selectionStart !== ta.selectionEnd;
      const pos = ta.selectionStart ?? 0;
      const ctrlAny = e.ctrlKey || e.metaKey;
      const keyLc = (e.key||"").toLowerCase();
      // let native undo/redo (Ctrl+Z/Y) pass through — textarea history
      if(ctrlAny && !e.altKey && (keyLc==="z" || keyLc==="y")) {
        // still handle notepad's own undo stack for line ops? keep native for now
        // but intercept for notepad undo/redo only if we have history?
        // preserve prior behaviour: Ctrl+Z without shift -> undo, Ctrl+Y or Ctrl+Shift+Z -> redo
        if(keyLc==="z" && !e.shiftKey){
          // let browser handle if no notepad history? we have history, so handle
          if(historyRef.current.length){
            e.preventDefault();
            undoNotepad();
          }
          return;
        }
        if(keyLc==="y" || (keyLc==="z" && e.shiftKey)){
          if(futureRef.current.length){
            e.preventDefault();
            redoNotepad();
          }
          return;
        }
        return;
      }
      let hkMap = {};
      try{ hkMap = (api.settings().hotkeys||{}); }catch{}
      const eff = (id, def)=>{
        const v = hkMap[id];
        if(v===null) return null;
        if(typeof v==="string" && v) return v;
        return def;
      };
      const m = (b)=> b ? api.matchesEvent(e, b) : false;
      if(!hasSel && m(eff("editorCopyLine","Ctrl+C"))){
        const line = npOpCopyLine(text, pos);
        if(line!=null){ e.preventDefault(); npCopyToClipboard(line); return; }
      }
      if(!hasSel && m(eff("editorCutLine","Ctrl+X"))){
        const line=npOpCopyLine(text,pos);
        const cut=npOpCutLine(text,pos);
        e.preventDefault();
        if(line) npCopyToClipboard(line);
        updateContent(cut.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(cut.caret, cut.caret);}catch{} });
        return;
      }
      if(m(eff("editorDeleteLine","Ctrl+Shift+K"))){
        e.preventDefault();
        const r=npOpDeleteLine(text, ta.selectionStart??0, ta.selectionEnd??0);
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret,r.caret);}catch{} });
        return;
      }
      if(m(eff("editorSelectLine","Ctrl+L"))){
        e.preventDefault();
        const {start,end}=npOpSelectLine(text,pos);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(start,end);}catch{} });
        return;
      }
      if(m(eff("editorToggleComment","Ctrl+/"))){
        e.preventDefault();
        const r=npOpToggleComment(text, ta.selectionStart??0, ta.selectionEnd??0);
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret, r.selEnd);}catch{} });
        return;
      }
      if(m(eff("editorMoveUp","Alt+ArrowUp"))){
        e.preventDefault();
        const r=npOpMoveLine(text, ta.selectionStart??0, ta.selectionEnd??0, "up");
        if(!r) return;
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret,r.caret);}catch{} });
        return;
      }
      if(m(eff("editorMoveDown","Alt+ArrowDown"))){
        e.preventDefault();
        const r=npOpMoveLine(text, ta.selectionStart??0, ta.selectionEnd??0, "down");
        if(!r) return;
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret,r.caret);}catch{} });
        return;
      }
      if(m(eff("editorDuplicateUp","Shift+Alt+ArrowUp"))){
        e.preventDefault();
        const r=npOpDuplicate(text, ta.selectionStart??0, ta.selectionEnd??0, "up");
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret,r.caret);}catch{} });
        return;
      }
      if(m(eff("editorDuplicateDown","Shift+Alt+ArrowDown"))){
        e.preventDefault();
        const r=npOpDuplicate(text, ta.selectionStart??0, ta.selectionEnd??0, "down");
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret,r.caret);}catch{} });
        return;
      }
      if(m(eff("editorInsertBelow","Ctrl+Enter"))){
        e.preventDefault();
        const r=npOpInsertLine(text,pos,"below");
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret,r.caret);}catch{} });
        return;
      }
      if(m(eff("editorInsertAbove","Ctrl+Shift+Enter"))){
        e.preventDefault();
        const r=npOpInsertLine(text,pos,"above");
        updateContent(r.text);
        requestAnimationFrame(()=>{ try{ ta.setSelectionRange(r.caret,r.caret);}catch{} });
        return;
      }
    };

    const addTab = ()=>{
      const id = uid();
      const n = state.tabs.length + 1;
      const title = `Note ${n}`;
      apply(s=> ({...s, tabs:[...s.tabs, {id, title, content:""}], activeId:id}), true);
      setRenaming(id); setDraftName(title);
      try{ api.playSound("expand"); }catch{}
    };

    const closeTab = (id, e)=>{
      if(e) e.stopPropagation();
      apply(s=>{
        if(s.tabs.length===1){
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
      }, true);
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
      if(t) apply(s=> ({...s, tabs: s.tabs.map(x=> x.id===id ? {...x, title:t.slice(0,40)} : x)}), true);
      setRenaming(null);
    };
    const cancelRename = ()=> setRenaming(null);

    const closePanel = ()=>{
      // flush pending typing first
      if(pendingRef.current){ save(pendingRef.current, false); pendingRef.current=null; clearTimeout(saveTimer.current); }
      const s = {...stateRef.current, open:false};
      save(s, true); setState(s);
      try{ api.playSound("collapse"); }catch{}
    };

    // drag header — direct DOM move at 60fps, React state only on drop
    const onDragStart = (e)=>{
      if(e.button!==0) return;
      if(e.target.closest("button, input")) return;
      e.preventDefault();
      const el = panelRef.current;
      if(!el) return;
      const startX = e.clientX, startY = e.clientY;
      const g0 = {...geom};
      dragRef.current = { startX, startY, g0 };
      document.body.style.userSelect="none";
      let raf=0, last={x:g0.x, y:g0.y};
      const flush = ()=>{
        raf=0;
        el.style.left = last.x+"px";
        el.style.top = last.y+"px";
      };
      const move = (ev)=>{
        const d = dragRef.current; if(!d) return;
        last.x = clamp(d.g0.x + (ev.clientX - d.startX), 0, Math.max(0, window.innerWidth - g0.w));
        last.y = clamp(d.g0.y + (ev.clientY - d.startY), 0, Math.max(0, window.innerHeight - 80));
        if(!raf) raf=requestAnimationFrame(flush);
      };
      const up = ()=>{
        if(raf) cancelAnimationFrame(raf);
        el.style.left = last.x+"px";
        el.style.top = last.y+"px";
        // commit once
        setState(s=>{
          if(s.geom.x===last.x && s.geom.y===last.y) return s;
          const next={...s, geom:{...s.geom, x:last.x, y:last.y}};
          save(next, true);
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

    // resize — direct DOM, rAF, commit on mouseup
    const onResizeStart = (dir)=>(e)=>{
      if(e.button!==0) return;
      e.preventDefault(); e.stopPropagation();
      const el = panelRef.current;
      if(!el) return;
      const sx=e.clientX, sy=e.clientY;
      const g0={...geom};
      resizeRef.current={dir, sx, sy, g0};
      document.body.style.userSelect="none";
      let raf=0, last={...g0};
      const flush=()=>{
        raf=0;
        el.style.left = last.x+"px";
        el.style.top = last.y+"px";
        el.style.width = last.w+"px";
        el.style.height = last.h+"px";
      };
      const move=(ev)=>{
        const r=resizeRef.current; if(!r) return;
        let {x,y,w,h}=r.g0;
        const dx=ev.clientX - r.sx, dy=ev.clientY - r.sy;
        if(r.dir.includes("e")) w = clamp(g0.w + dx, MIN_W, Math.min(MAX_W, window.innerWidth - x - 6));
        if(r.dir.includes("s")) h = clamp(g0.h + dy, MIN_H, Math.min(MAX_H, window.innerHeight - y - 6));
        if(r.dir.includes("w")){ const nw=clamp(g0.w - dx, MIN_W, g0.x + g0.w); x = g0.x + g0.w - nw; w=nw; x=clamp(x,0,window.innerWidth - MIN_W); }
        if(r.dir.includes("n")){ const nh=clamp(g0.h - dy, MIN_H, g0.y + g0.h); y = g0.y + g0.h - nh; h=nh; y=clamp(y,0,window.innerHeight - MIN_H); }
        last={x,y,w,h};
        if(!raf) raf=requestAnimationFrame(flush);
      };
      const up=()=>{
        if(raf) cancelAnimationFrame(raf);
        el.style.left = last.x+"px";
        el.style.top = last.y+"px";
        el.style.width = last.w+"px";
        el.style.height = last.h+"px";
        setState(s=>{
          if(equal(s.geom,last)) return s;
          const next={...s, geom:last};
          save(next, true);
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
              "data-tip":"Double-click to rename"
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
          onChange:(e)=> updateContent(e.target.value),
          onKeyDown: onNotepadKeyDown
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

  function toggleNotepad(){
    try{
      const s = load();
      s.open = !s.open;
      save(s);
      try{ api.playSound(s.open ? "expand" : "collapse"); }catch{}
    }catch{}
  }

  return {
    Titlebar: TitlebarBtn,
    Overlay: Overlay,
    hotkeys: [
      { id: "toggle", default: "Alt+N", label: "toggle notepad", description: "Show/hide floating notepad" },
    ],
    onHotkey(id){
      if(id === "toggle") toggleNotepad();
    },
    info:{ keys:[
      ["Alt+N / Notepad (Titlebar)","Toggle floating notepad (sticky-note icon) — rebindable in Hotkeys"],
      ["Ctrl+C / Ctrl+X (no selection)","Copy / cut current line"],
      ["Ctrl+Shift+K","Delete line"],
      ["Alt+↑ / Alt+↓","Move line up / down"],
      ["Shift+Alt+↑ / Shift+Alt+↓","Duplicate line up / down"],
      ["Ctrl+/","Toggle line comment (//)"],
      ["Ctrl+L","Select line"],
      ["Ctrl+Enter / Ctrl+Shift+Enter","Insert line below / above"],
    ] }
  };
}
