import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { opencode } from "../api";
import { extLang, hlHtml } from "../lib/syntax";
import { handleEditorKeys } from "../lib/editorKeys";
import { findMatches, highlightFindInHtml } from "../lib/find";
import Dialog from "./Dialog";
import "../styles/file-editor.css";
import "../styles/find.css";

// centered editable file viewer — portal-mounted so the sidebar's
// backdrop-filter ancestors can't turn position:fixed into sidebar-relative
export default function FileEditor({
  path,
  absolute,
  onDirty,
  onClose,
}: {
  path: string;
  absolute: string;
  // lets the tree ask before replacing a dirty editor with another file
  onDirty?: (dirty: boolean) => void;
  onClose: () => void;
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

  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(false);
  // undo/redo for programmatic line ops (cut, delete, move, etc.) — native
  // textarea history is lost for controlled value, so we keep our own
  const historyRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
  const isUndoRedoRef = useRef(false);

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
      const text = fc?.content ?? "";
      setSaved(text);
      setDraft(text);
      historyRef.current = [];
      futureRef.current = [];
      setStaleDisk(null);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
    historyRef.current = [];
    futureRef.current = [];
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
        goto(cur + (e.shiftKey ? -1 : 1));
      } else if (e.key === "F3" && findOpen && editable) {
        e.preventDefault();
        goto(cur + (e.shiftKey ? -1 : 1));
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
      openFind();
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

  const matches = useMemo(() => {
    if (!findOpen || !query) return [];
    return findMatches(draft, query, matchCase);
  }, [draft, query, matchCase, findOpen]);

  const syncScroll = () => {
    const hl = hlRef.current;
    const ta = taRef.current;
    if (!hl || !ta) return;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  };
  useEffect(() => {
    syncScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const deferred = useDeferredValue(draft);
  const lang = extLang(path);
  const hlBase = useMemo(
    // trailing newline: pre collapses the final empty line a textarea shows
    () => hlHtml(deferred, lang) + (/\n$/.test(deferred) ? "\n" : ""),
    [deferred, lang],
  );
  const hlMarkup = useMemo(() => {
    if (!findOpen || !query || !matches.length) return hlBase;
    return highlightFindInHtml(hlBase, query, matchCase, cur);
  }, [hlBase, findOpen, query, matchCase, cur, matches.length]);

  const goto = (idx: number) => {
    if (!matches.length) return;
    const j = ((idx % matches.length) + matches.length) % matches.length;
    setCur(j);
    const ta = taRef.current;
    if (!ta) return;
    const start = matches[j];
    ta.focus();
    ta.setSelectionRange(start, start + query.length);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 17;
    const line = (draft.slice(0, start).match(/\n/g) ?? []).length;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
    syncScroll();
  };

  const openFind = () => {
    const ta = taRef.current;
    if (ta && ta.selectionStart !== ta.selectionEnd)
      setQuery(draft.slice(ta.selectionStart, ta.selectionEnd));
    setCur(0);
    setFindOpen(true);
    window.dispatchEvent(new CustomEvent("oc:find-opened", { detail: "file" }));
  };

  // stopPropagation keeps Dialog's window Escape handler closed
  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      setFindOpen(false);
      taRef.current?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      goto(cur + (e.shiftKey ? -1 : 1));
    }
  };

  const applyEdit = (text: string) => {
    if (text === draftRef.current) return;
    if (!isUndoRedoRef.current) {
      historyRef.current.push(draftRef.current);
      if (historyRef.current.length > 200) historyRef.current.shift();
      futureRef.current = [];
    }
    setDraft(text);
    setStatus("");
  };

  const undo = () => {
    const h = historyRef.current;
    if (!h.length) return false;
    const prev = h.pop()!;
    futureRef.current.push(draftRef.current);
    isUndoRedoRef.current = true;
    setDraft(prev);
    setStatus("");
    requestAnimationFrame(() => {
      isUndoRedoRef.current = false;
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        try {
          const pos = Math.min(ta.selectionStart ?? 0, prev.length);
          ta.setSelectionRange(pos, pos);
        } catch {}
      }
    });
    return true;
  };

  const redo = () => {
    const f = futureRef.current;
    if (!f.length) return false;
    const next = f.pop()!;
    historyRef.current.push(draftRef.current);
    isUndoRedoRef.current = true;
    setDraft(next);
    setStatus("");
    requestAnimationFrame(() => {
      isUndoRedoRef.current = false;
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        try {
          const pos = Math.min(ta.selectionStart ?? 0, next.length);
          ta.setSelectionRange(pos, pos);
        } catch {}
      }
    });
    return true;
  };

  const replaceCurrent = () => {
    if (!matches.length) return;
    const s = matches[Math.min(cur, matches.length - 1)];
    applyEdit(draft.slice(0, s) + repl + draft.slice(s + query.length));
  };

  const replaceAll = () => {
    if (!query) return;
    const rx = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      matchCase ? "g" : "gi",
    );
    applyEdit(draft.replace(rx, () => repl));
  };

  const onEdit = (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    applyEdit(e.target.value);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (findOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(false);
      return;
    }
    const ta = e.currentTarget;
    const isMod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (isMod && !e.altKey && k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (isMod && !e.altKey && (k === "y" || (k === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
      return;
    }
    if (handleEditorKeys(e, ta, draft, applyEdit, { path, allowInsert: true })) return;
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      applyEdit(draft.slice(0, s) + "  " + draft.slice(en));
      requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
    }
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
            data-tip="Find and replace (Ctrl+F)"
            disabled={!editable}
            onClick={() => (findOpen ? (setFindOpen(false), taRef.current?.focus()) : openFind())}
          >
            <i className="fa-solid fa-magnifying-glass" />
          </button>
          <button
            className="icon-btn"
            data-tip="Save (Ctrl+S)"
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
          <pre
            className="fe-hl mono"
            ref={hlRef}
            dangerouslySetInnerHTML={{ __html: hlMarkup }}
          />
          <textarea
            ref={taRef}
            className="fe-ta mono"
            value={draft}
            spellCheck={false}
            wrap="off"
            onChange={onEdit}
            onScroll={syncScroll}
            onKeyDown={onKeyDown}
          />
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
