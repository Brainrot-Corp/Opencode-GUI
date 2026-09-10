import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import {
  MONACO_THEME,
  MONO_STACK,
  defineGuiTheme,
  hlToMonacoLang,
  loadMonaco,
} from "../lib/monaco";

type Row = { cls: "add" | "del" | "ctx" | "hunk"; sign: string; text: string };

// tall diffs scroll inside the block instead of stretching the chat;
// keep in sync with .ro-diff / .ro-fallback max-height in diff.css
const MAX_H = 420;
// wide diffs grow into free stage space (assistant bubbles stop at 84%)
// before scrolling horizontally — capped so it stays a nudge, not a takeover
const MAX_EXPAND = 320;

let charW = 0;
function monoCharWidth(): number {
  if (charW > 0) return charW;
  try {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `12px ${MONO_STACK}`;
    charW = Math.ceil(ctx.measureText("MMMMMMMMMM").width / 10);
  } catch {
    charW = 8;
  }
  return charW;
}

// same row split as the old DOM version: hunk/file headers stay whole,
// +/- prefixes are stripped into the sign gutter so token colors stay clean
function parsePatch(patch: string): Row[] {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const rows: Row[] = [];
  for (const l of lines) {
    if (l.startsWith("@@")) {
      rows.push({ cls: "hunk", sign: " ", text: l });
      continue;
    }
    if (/^(---|\+\+\+|diff |index |old mode|new mode)/.test(l)) {
      rows.push({ cls: "ctx", sign: " ", text: l });
      continue;
    }
    const cls = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
    const sign = cls === "add" ? "+" : cls === "del" ? "-" : " ";
    const text = cls === "ctx" ? (l.startsWith(" ") ? l.slice(1) : l) : l.slice(1);
    rows.push({ cls, sign, text });
  }
  return rows;
}

// read-only unified diff rendered with monaco — same rows, sign gutter and
// row tints as before; code keeps per-language token colors via the file
// language, diff-ness comes only from gutter signs + line decorations
export default function ReadOnlyDiff({ patch, lang }: { patch: string; lang?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const fallRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decosRef = useRef<string[]>([]);
  const [mod, setMod] = useState<typeof Monaco | null>(null);
  // any monaco failure degrades to the plain-rows fallback below (with the
  // reason inline) instead of unmounting the whole chat — there is no error
  // boundary above tool blocks, so an uncaught throw blanks the window
  const [fail, setFail] = useState<string | null>(null);

  const rows = useMemo(() => parsePatch(patch), [patch]);
  const text = useMemo(() => rows.map((r) => r.text).join("\n"), [rows]);
  const signs = useMemo(() => rows.map((r) => r.sign), [rows]);
  const signsRef = useRef(signs);
  signsRef.current = signs;
  // creation reads these so the editor is born with full content (no
  // empty→fill transition for height to get stuck on)
  const textRef = useRef(text);
  textRef.current = text;
  const langRef = useRef(lang);
  langRef.current = lang;
  const fitRef = useRef<(() => void) | null>(null);
  const longest = useMemo(() => rows.reduce((m, r) => Math.max(m, r.text.length), 0), [rows]);
  // grammars compile on first use per language — run one synchronous pass
  // so colors are ready for first paint instead of popping in a beat later
  const warmLangRef = useRef<string | null>(null);

  // grow the block toward the longest line when free stage space allows —
  // capped at MAX_EXPAND past the natural column width and never past the
  // scroller, so the chat itself never gains a horizontal scrollbar
  const applyWidth = useCallback(() => {
    const box = mountRef.current ?? fallRef.current;
    if (!box || !box.isConnected) return;
    const natural = box.parentElement?.clientWidth || box.clientWidth;
    const ed = edRef.current;
    const left = ed ? ed.getLayoutInfo().contentLeft : 18;
    const needed = Math.ceil(left + longest * monoCharWidth() + 14);
    let avail = natural + MAX_EXPAND;
    const scroller = box.closest(".messages, .dlg-body");
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      const pr = parseFloat(getComputedStyle(scroller).paddingRight || "0") || 0;
      avail = Math.floor(sr.right - br.left - pr - 4);
    }
    const target = Math.min(needed, Math.min(natural + MAX_EXPAND, avail));
    if (target > natural + 32) {
      box.style.width = `${Math.floor(target)}px`;
      try {
        ed?.layout();
      } catch {}
    } else if (box.style.width) {
      box.style.width = "";
      try {
        ed?.layout();
      } catch {}
    }
  }, [longest]);

  useEffect(() => {
    applyWidth();
  }, [applyWidth]);
  useEffect(() => {
    window.addEventListener("resize", applyWidth);
    return () => window.removeEventListener("resize", applyWidth);
  }, [applyWidth]);

  useEffect(() => {
    let dead = false;
    void loadMonaco().then(
      (m) => {
        if (!dead) setMod(m);
      },
      (e) => {
        if (!dead) setFail(`load: ${e}`);
      },
    );
    return () => {
      dead = true;
    };
  }, []);

  // create once monaco arrives; height follows content up to MAX_H, then
  // the block scrolls internally instead of stretching the chat
  useEffect(() => {
    if (!mod || fail || edRef.current || !mountRef.current) return;
    let ed: Monaco.editor.IStandaloneCodeEditor | null = null;
    let sizeSub: Monaco.IDisposable | null = null;
    try {
      defineGuiTheme(mod);
      ed = mod.editor.create(mountRef.current, {
      theme: MONACO_THEME,
      value: textRef.current,
      language: hlToMonacoLang(langRef.current),
      readOnly: true,
      fontFamily: MONO_STACK,
      fontSize: 12,
      lineHeight: 19,
      fontLigatures: false,
      tabSize: 2,
      wordWrap: "off",
      minimap: { enabled: false },
      // stable identity reading live signs — never updateOptions'd, so the
      // gutter stays correct across patch updates with no re-render churn
      lineNumbers: (n: number) => signsRef.current[n - 1] ?? " ",
      lineNumbersMinChars: 1,
      glyphMargin: false,
      folding: false,
      showFoldingControls: "never",
      lineDecorationsWidth: 10,
      padding: { top: 6, bottom: 6 },
      renderLineHighlight: "none",
      occurrencesHighlight: "off",
      selectionHighlight: false,
      matchBrackets: "never",
      links: false,
      contextmenu: false,
      copyWithSyntaxHighlighting: false,
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      stickyScroll: { enabled: false },
      guides: { bracketPairs: false, indentation: false },
      fixedOverflowWidgets: true,
      automaticLayout: true,
      smoothScrolling: true,
      scrollbar: {
        vertical: "auto",
        horizontal: "auto",
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      ariaLabel: "Diff",
      });
      edRef.current = ed;
      const fit = () => {
        const el = mountRef.current;
        if (!el || !ed) return;
        el.style.height = `${Math.min(ed.getContentHeight(), MAX_H)}px`;
        try {
          ed.layout();
        } catch {}
      };
      fitRef.current = fit;
      sizeSub = ed.onDidContentSizeChange(fit);
      fit();
    } catch (e) {
      try {
        ed?.dispose();
      } catch {}
      edRef.current = null;
      setFail(`create: ${e instanceof Error ? e.message : e}`);
      return;
    }
    return () => {
      sizeSub?.dispose();
      fitRef.current = null;
      edRef.current = null;
      decosRef.current = [];
      if (!ed) return;
      const m = ed.getModel();
      ed.dispose();
      m?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod, fail]);

  // patch/language updates (streaming tool output): sync text, gutter signs,
  // language and row decorations — height follows via contentSizeChange
  useEffect(() => {
    const ed = edRef.current;
    if (!ed || !mod || fail) return;
    try {
      const model = ed.getModel();
      if (!model) return;
      if (model.getValue() !== text) {
        ed.executeEdits("diff-update", [{ range: model.getFullModelRange(), text }]);
      }
      const monacoLangId = hlToMonacoLang(lang);
      if (model.getLanguageId() !== monacoLangId) {
        mod.editor.setModelLanguage(model, monacoLangId);
      }
      if (warmLangRef.current !== monacoLangId && text.length < 500_000) {
        warmLangRef.current = monacoLangId;
        try {
          mod.editor.tokenize(text, monacoLangId);
        } catch {}
      }
      // whole-line background + inline text color per row — exactly the old
      // .diff-lines look (plain text takes the row color, token spans keep
      // theirs). Ranges come from string lengths only, never the model, so
      // no out-of-range access is possible whatever the patch contains
      // (deltaDecorations would clamp anyway).
      const decos: Monaco.editor.IModelDeltaDecoration[] = [];
      rows.forEach((r, i) => {
        const ln = i + 1;
        const bg =
          r.cls === "add"
            ? "ro-row ro-add"
            : r.cls === "del"
              ? "ro-row ro-del"
              : r.cls === "hunk"
                ? undefined
                : "ro-row ro-ctx";
        if (bg) {
          decos.push({
            range: new mod.Range(ln, 1, ln, 1),
            options: { isWholeLine: true, className: bg },
          });
        }
        if (r.text) {
          const fg =
            r.cls === "add"
              ? "ro-add-inline"
              : r.cls === "del"
                ? "ro-del-inline"
                : r.cls === "hunk"
                  ? "ro-hunk-inline"
                  : undefined;
          if (fg) {
            decos.push({
              range: new mod.Range(ln, 1, ln, r.text.length + 1),
              options: { inlineClassName: fg },
            });
          }
        }
      });
      decosRef.current = ed.deltaDecorations(decosRef.current, decos);
      // explicit refit alongside the contentSizeChange event — belt and
      // suspenders so the block can never get stuck at a stale height
      try {
        fitRef.current?.();
      } catch {}
      applyWidth();
    } catch (e) {
      try {
        ed.dispose();
      } catch {}
      edRef.current = null;
      decosRef.current = [];
      setFail(`sync: ${e instanceof Error ? e.message : e}`);
    }
  }, [mod, rows, text, lang, fail, applyWidth]);

  // monaco unavailable (still loading, or load/create/sync failed) — plain
  // rows, no highlight (same shape, so no layout jump when the editor takes
  // over); the failure reason stays visible inline for diagnosis
  if (!mod || fail) {
    if (!patch.trim()) return null;
    return (
      <div ref={fallRef} className="diff-lines mono ro-fallback">
        {fail && <div className="ro-fail">Monaco unavailable ({fail})</div>}
        {rows.map((r, i) => (
          <div key={i} className={r.cls}>
            <span className="sign">{r.sign}</span>
            {r.text}
          </div>
        ))}
      </div>
    );
  }
  if (!patch.trim()) return null;
  return <div ref={mountRef} className="ro-diff" />;
}
