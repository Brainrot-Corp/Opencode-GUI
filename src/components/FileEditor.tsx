import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";
import { opencode } from "../api";
import {
  baseOptions,
  bindingToKeybinding,
  defineGuiTheme,
  forceCheapTokens,
  monacoLang,
  setupMonacoWorkers,
  whenGrammarReady,
} from "../lib/monaco";
import { copyToClipboard } from "../lib/editorKeys";
import { DEFAULT_HOTKEYS } from "../lib/hotkeys";
import { fmtKey } from "../lib/tip";
import { findMatches } from "../lib/find";
import Dialog from "./Dialog";
import "../styles/file-editor.css";
import "../styles/find.css";

setupMonacoWorkers();

// centered editable file viewer — portal-mounted so the sidebar's
// backdrop-filter ancestors can't turn position:fixed into sidebar-relative.
// Rendering is Monaco; all surrounding chrome + logic (dirty, autosave,
// custom find bar, stale-disk banner) is unchanged from the textarea version.
export default function FileEditor({
  path,
  absolute,
  onDirty,
  onClose,
  hotkeys,
}: {
  path: string;
  absolute: string;
  // lets the tree ask before replacing a dirty editor with another file
  onDirty?: (dirty: boolean) => void;
  onClose: () => void;
  hotkeys?: Record<string, string | null>;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [staleDisk, setStaleDisk] = useState<string | null>(null);
  const [autosave, setAutosave] = useState(
    () => localStorage.getItem("oc.fv.autosave") === "1",
  );
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [repl, setRepl] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [cur, setCur] = useState(0);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  // two-step close: first attempt with unsaved edits arms, second commits
  const [closeArmed, setCloseArmed] = useState(false);

  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decosRef = useRef<string[]>([]);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(false);

  const dirty = saved !== null && draft !== saved;
  const editable = !binary && !error && saved !== null;

  useEffect(() => {
    onDirty?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  async function load() {
    try {
      const { client } = await opencode();
      const r: any = await client.file.read({ query: { path } });
      const fc = r.data;
      if (fc?.type === "binary") {
        setBinary(true);
        setSaved(null);
        setError("");
        return;
      }
      const raw = fc?.content ?? "";
      // normalize CRLF to LF for editing (save also as LF)
      const text = raw.includes("\r") ? raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : raw;
      setSaved(text);
      setDraft(text);
      setStaleDisk(null);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    const s = savedRef.current;
    const d = draftRef.current;
    if (s === null || d === s) return;
    savingRef.current = true;
    setStatus("Saving…");
    try {
      await invoke("write_file", { path: absolute, content: d });
      setSaved(d);
      setStatus("Saved");
    } catch (e) {
      setStatus(String(e));
    }
    savingRef.current = false;
  }, [absolute]);

  useEffect(() => {
    if (!autosave || saved === null || draft === saved) return;
    const t = setTimeout(() => void save(), 800);
    return () => clearTimeout(t);
  }, [draft, autosave, saved, save]);

  function toggleAutosave() {
    setAutosave((v) => {
      localStorage.setItem("oc.fv.autosave", v ? "0" : "1");
      return !v;
    });
  }

  const requestClose = () => {
    if (dirty && !autosave) {
      if (!closeArmed) {
        setCloseArmed(true);
        return;
      }
      setCloseArmed(false);
    }
    onClose();
  };

  // armed state expires like the sidebar clear-all, and saving disarms
  useEffect(() => {
    if (!closeArmed) return;
    const t = setTimeout(() => setCloseArmed(false), 3000);
    return () => clearTimeout(t);
  }, [closeArmed]);
  useEffect(() => {
    if (!dirty) setCloseArmed(false);
  }, [dirty]);

  const matches = useMemo(() => {
    if (!findOpen || !query) return [];
    return findMatches(draft, query, matchCase);
  }, [draft, query, matchCase, findOpen]);

  // ---- monaco lifecycle: create once the text is loaded ----
  // text mounts immediately (instant open); colors follow as soon as the
  // grammar is live — waiting for colors first left an empty box instead

  useEffect(() => {
    if (!editable) return;
    const el = mountRef.current;
    if (!el) return;
    defineGuiTheme(monaco);
    const editor = monaco.editor.create(el, {
      ...baseOptions(monaco),
      value: draftRef.current,
      language: monacoLang(path),
    });
    editorRef.current = editor;
    forceCheapTokens(editor.getModel());
    // grammar may still be loading (cold language, busy thread) — repaint
    // the moment it's usable instead of waiting on the idle queue
    void whenGrammarReady(monaco, monacoLang(path)).then(() => {
      if (editorRef.current !== editor) return;
      const m = editor.getModel();
      if (m) forceCheapTokens(m);
    });
    const sub = editor.onDidChangeModelContent(() => {
      const v = editor.getValue();
      if (v !== draftRef.current) {
        draftRef.current = v;
        setDraft(v);
        setStatus("");
        // paint the just-typed line synchronously — same idle-starvation
        // reasoning as everywhere else; post-warmup this is one cheap line
        // plus trivial validity checks, far below the setState next to it
        forceCheapTokens(editor.getModel());
      }
    });
    // Escape closes the custom find bar first (Dialog closes on Escape otherwise)
    const keySub = editor.onKeyDown((e) => {
      if (findOpenRef.current && e.keyCode === monaco.KeyCode.Escape) {
        setFindOpen(false);
        e.preventDefault();
        e.stopPropagation();
      }
    });
    return () => {
      keySub.dispose();
      sub.dispose();
      editorRef.current = null;
      decosRef.current = [];
      const m = editor.getModel();
      editor.dispose();
      m?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, path]);

  // external draft updates (initial load, watcher reload, stale reload)
  // push into the editor; keystrokes already match so this is a no-op for them
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    if (draft !== editor.getValue()) {
      editor.executeEdits("external", [{ range: model.getFullModelRange(), text: draft }]);
      forceCheapTokens(model);
    }
  }, [draft]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    monaco.editor.setModelLanguage(model, monacoLang(path));
  }, [path]);

  // rebindable line ops on top of monaco built-ins. Bindings left at their
  // VS Code default are already correct natively, so only non-default
  // bindings get an overriding action (avoids double-firing the default).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editable) return;
    let hk: Record<string, string | null> | undefined = hotkeys;
    if (!hk) {
      try {
        hk = JSON.parse(localStorage.getItem("oc.settings") || "{}").hotkeys;
      } catch {
        hk = undefined;
      }
    }
    const binding = (id: keyof typeof DEFAULT_HOTKEYS): string | null =>
      (hk as any)?.[id] ?? DEFAULT_HOTKEYS[id];
    const sameAsDefault = (id: keyof typeof DEFAULT_HOTKEYS): boolean =>
      binding(id) === DEFAULT_HOTKEYS[id];
    const disps: monaco.IDisposable[] = [];
    const addOverride = (id: keyof typeof DEFAULT_HOTKEYS, run: (ed: monaco.editor.IStandaloneCodeEditor) => void) => {
      if (sameAsDefault(id)) return;
      const kb = bindingToKeybinding(monaco, binding(id));
      if (kb == null) return;
      disps.push(
        editor.addAction({ id: `fe-${id}`, label: id, keybindings: [kb], run: (ed) => run(ed as monaco.editor.IStandaloneCodeEditor) }),
      );
    };
    const trigger = (ed: monaco.editor.IStandaloneCodeEditor, action: string) =>
      ed.trigger("fe", action, null);

    // copy/cut line when the selection is empty — native emptySelectionClipboard
    // already covers the Ctrl+C/X defaults, so these only fire for custom binds
    addOverride("editorCopyLine", (ed) => {
      const m = ed.getModel();
      const s = ed.getSelection();
      if (!m || !s || !s.isEmpty()) return;
      copyToClipboard(m.getLineContent(s.positionLineNumber) + m.getEOL());
    });
    addOverride("editorCutLine", (ed) => {
      const m = ed.getModel();
      const s = ed.getSelection();
      if (!m || !s || !s.isEmpty()) return;
      const ln = s.positionLineNumber;
      copyToClipboard(m.getLineContent(ln) + m.getEOL());
      const max = m.getLineCount();
      const range =
        ln < max
          ? new monaco.Range(ln, 1, ln + 1, 1)
          : ln > 1
            ? new monaco.Range(ln - 1, m.getLineMaxColumn(ln - 1), ln, m.getLineMaxColumn(ln))
            : new monaco.Range(ln, 1, ln, m.getLineMaxColumn(ln));
      ed.executeEdits("fe-cut-line", [{ range, text: "" }]);
    });
    addOverride("editorDeleteLine", (ed) => trigger(ed, "editor.action.deleteLines"));
    addOverride("editorToggleComment", (ed) => trigger(ed, "editor.action.commentLine"));
    addOverride("editorMoveUp", (ed) => trigger(ed, "editor.action.moveLinesUpAction"));
    addOverride("editorMoveDown", (ed) => trigger(ed, "editor.action.moveLinesDownAction"));
    addOverride("editorDuplicateUp", (ed) => trigger(ed, "editor.action.copyLinesUpAction"));
    addOverride("editorDuplicateDown", (ed) => trigger(ed, "editor.action.copyLinesDownAction"));
    addOverride("editorInsertBelow", (ed) => trigger(ed, "editor.action.insertLineAfter"));
    addOverride("editorInsertAbove", (ed) => trigger(ed, "editor.action.insertLineBefore"));
    // select-line has no stable built-in id across monaco versions — do it directly
    addOverride("editorSelectLine", (ed) => {
      const m = ed.getModel();
      const s = ed.getSelection();
      if (!m || !s) return;
      let end = s.endLineNumber;
      if (end > s.startLineNumber && s.endColumn === 1) end -= 1;
      ed.setSelection(new monaco.Range(s.startLineNumber, 1, end, m.getLineMaxColumn(end)));
    });
    // save + custom-find entry must work with focus inside monaco too
    disps.push(
      editor.addAction({
        id: "fe-save",
        label: "Save",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => void save(),
      }),
    );
    disps.push(
      editor.addAction({
        id: "fe-find",
        label: "Find",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF],
        run: () => openFindRef.current(),
      }),
    );
    return () => disps.forEach((d) => d.dispose());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, hotkeys, path, save]);

  // ---- custom find, wired to monaco selections + inline decorations ----

  // find-hit classes come from styles/find.css, same colors as before
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!findOpen || !query || !matches.length) {
      decosRef.current = editor.deltaDecorations(decosRef.current, []);
      return;
    }
    const active = ((cur % matches.length) + matches.length) % matches.length;
    decosRef.current = editor.deltaDecorations(
      decosRef.current,
      matches.map((off) => {
        const s = model.getPositionAt(off);
        const e = model.getPositionAt(off + query.length);
        return {
          range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
          options: {
            inlineClassName: off === matches[active] ? "find-hit active" : "find-hit",
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      }),
    );
  }, [findOpen, query, matchCase, cur, matches]);

  const goto = (idx: number) => {
    if (!matches.length) return;
    const j = ((idx % matches.length) + matches.length) % matches.length;
    setCur(j);
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const s = model.getPositionAt(matches[j]);
    const e = model.getPositionAt(matches[j] + query.length);
    editor.setSelection(new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column));
    editor.revealLineInCenter(s.lineNumber);
    editor.focus();
  };
  const gotoRef = useRef(goto);
  gotoRef.current = goto;

  const openFind = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const sel = editor?.getSelection();
    if (editor && model && sel && !sel.isEmpty())
      setQuery(model.getValueInRange(sel));
    setCur(0);
    setFindOpen(true);
    window.dispatchEvent(new CustomEvent("oc:find-opened", { detail: "file" }));
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;

  // Ctrl+S save + navigation — find open is routed via oc:file-find
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void save();
      } else if (k === "g" && findOpen && editable) {
        e.preventDefault();
        gotoRef.current(cur + (e.shiftKey ? -1 : 1));
      } else if (e.key === "F3" && findOpen && editable) {
        e.preventDefault();
        gotoRef.current(cur + (e.shiftKey ? -1 : 1));
      }
    };
    window.addEventListener("keydown", key, { capture: true } as any);
    return () => window.removeEventListener("keydown", key, { capture: true } as any);
  });
  useEffect(() => {
    const onFind = () => {
      if (!editable) return;
      if (findOpenRef.current) {
        const input = document.querySelector(".fe-find .fe-input") as HTMLInputElement | null;
        input?.focus();
        input?.select();
        return;
      }
      openFindRef.current();
    };
    window.addEventListener("oc:file-find", onFind);
    return () => window.removeEventListener("oc:file-find", onFind);
  });
  useEffect(() => {
    const onOther = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== "file" && findOpenRef.current) setFindOpen(false);
    };
    window.addEventListener("oc:find-opened", onOther as EventListener);
    return () => window.removeEventListener("oc:find-opened", onOther as EventListener);
  });
  // close when clicking outside the find bar
  useEffect(() => {
    if (!findOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".fe-find")) return;
      setFindOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [findOpen]);

  // server SSE file.watcher.updated arrives relayed as oc:file-changed —
  // clean view silently reloads; local edits win and surface a stale banner
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const norm = (s: string) => s.replace(/\\/g, "/");
    const p = norm(path);
    const a = norm(absolute);
    const hit = (f: string) => {
      const n = norm(f);
      return n === a || n === p || n.endsWith("/" + p);
    };
    const onFileChanged = (ev: Event) => {
      if (!hit((ev as CustomEvent<string>).detail ?? "")) return;
      clearTimeout(t);
      t = setTimeout(async () => {
        try {
          const { client } = await opencode();
          const r: any = await client.file.read({ query: { path } });
          if (r.data?.type === "binary") return;
          const disk = r.data?.content ?? "";
          if (disk === savedRef.current && draftRef.current === savedRef.current)
            return; // echo of our own save
          if (draftRef.current !== savedRef.current) setStaleDisk(disk);
          else {
            setSaved(disk);
            setDraft(disk);
          }
        } catch {}
      }, 300);
    };
    window.addEventListener("oc:file-changed", onFileChanged);
    return () => {
      window.removeEventListener("oc:file-changed", onFileChanged);
      clearTimeout(t);
    };
  }, [path, absolute]);

  // stopPropagation keeps Dialog's window Escape handler closed
  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      setFindOpen(false);
      editorRef.current?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      goto(cur + (e.shiftKey ? -1 : 1));
    }
  };

  // programmatic text set (stale-disk reload) — keystrokes flow through the
  // monaco content listener instead; the draft→editor effect pushes this in
  const applyEdit = (text: string) => {
    if (text === draftRef.current) return;
    draftRef.current = text;
    setDraft(text);
    setStatus("");
  };

  const replaceCurrent = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !matches.length || !query) return;
    const off = matches[Math.min(cur, matches.length - 1)];
    const s = model.getPositionAt(off);
    const e = model.getPositionAt(off + query.length);
    editor.executeEdits("fe-replace", [{
      range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
      text: repl,
    }]);
    editor.focus();
  };

  const replaceAll = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !query || !matches.length) return;
    editor.executeEdits(
      "fe-replace-all",
      matches.map((off) => {
        const s = model.getPositionAt(off);
        const e = model.getPositionAt(off + query.length);
        return {
          range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
          text: repl,
        };
      }),
    );
    editor.focus();
  };

  const reloadFromDisk = () => {
    if (staleDisk === null) return;
    if (!window.confirm("Discard local edits and load the version from disk?")) return;
    applyEdit(staleDisk);
    setSaved(staleDisk);
    setStaleDisk(null);
  };

  return createPortal(
    <Dialog
      title={path}
      onClose={requestClose}
      stage
      actions={
        <>
          <span className={"fe-status mono" + (closeArmed ? " warn" : "")}>
            {closeArmed ? "Click again to discard" : status}
          </span>
          <span
            className={"fe-dot" + (dirty ? " on" : "")}
            data-tip={dirty ? "Unsaved changes" : "Saved"}
          />
          <button
            className={"icon-btn" + (autosave ? " on" : "")}
            data-tip={`Auto-save: ${autosave ? "on" : "off"}`}
            onClick={toggleAutosave}
          >
            <i className="fa-solid fa-bolt" />
          </button>
          <button
            className="icon-btn"
            data-tip={`Find and replace (${fmtKey("Ctrl+F")})`}
            disabled={!editable}
            onClick={() => (findOpen ? (setFindOpen(false), editorRef.current?.focus()) : openFind())}
          >
            <i className="fa-solid fa-magnifying-glass" />
          </button>
          <button
            className="icon-btn"
            data-tip={`Save (${fmtKey("Ctrl+S")})`}
            disabled={!dirty}
            onClick={() => void save()}
          >
            <i className="fa-solid fa-floppy-disk" />
          </button>
        </>
      }
      confirm={closeArmed}
    >
      {staleDisk !== null && (
        <div className="fe-stale">
          <i className="fa-solid fa-triangle-exclamation" />
          <span>Changed on disk while editing</span>
          <button
            className="icon-btn"
            data-tip="Reload from disk (discards local edits)"
            onClick={reloadFromDisk}
          >
            <i className="fa-solid fa-rotate-right" />
          </button>
          <button
            className="icon-btn"
            data-tip="Keep my version"
            onClick={() => setStaleDisk(null)}
          >
            <i className="fa-solid fa-check" />
          </button>
        </div>
      )}
      {findOpen && editable && (
        <div className="fe-find">
          <div className="fe-find-row">
            <input
              className="fe-input mono"
              placeholder="Find"
              value={query}
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value);
                setCur(0);
              }}
              onKeyDown={onFindKey}
            />
            <span className="fe-count mono">
              {query ? `${matches.length ? cur + 1 : 0}/${matches.length}` : ""}
            </span>
            <button className="icon-btn" data-tip="Previous (Shift+Enter)" onClick={() => goto(cur - 1)}>
              <i className="fa-solid fa-chevron-up" />
            </button>
            <button className="icon-btn" data-tip="Next (Enter)" onClick={() => goto(cur + 1)}>
              <i className="fa-solid fa-chevron-down" />
            </button>
            <button
              className={"icon-btn fe-cs" + (matchCase ? " on" : "")}
              data-tip="Match case"
              onClick={() => setMatchCase((v) => !v)}
            >
              Aa
            </button>
            <button
              className="icon-btn"
              data-tip="Close find (Esc)"
              onClick={() => setFindOpen(false)}
            >
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
          <div className="fe-find-row">
            <input
              className="fe-input mono"
              placeholder="Replace"
              value={repl}
              onChange={(e) => setRepl(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  replaceCurrent();
                }
              }}
            />
            <button className="fe-mini" onClick={replaceCurrent}>
              Replace
            </button>
            <button className="fe-mini" onClick={replaceAll}>
              All
            </button>
          </div>
        </div>
      )}
      {!editable && (
        <pre className="fe-ro mono">{binary ? "(binary file)" : error ? error : "Loading…"}</pre>
      )}
      {editable && (
        <div className="fe-stack">
          <div ref={mountRef} className="fe-monaco" />
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
