import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { ReactNode } from "react";
import {
  MONACO_THEME,
  MONO_STACK,
  defineGuiTheme,
  forceCheapTokens,
  loadMonaco,
  measureLineWidth,
  whenGrammarReady,
} from "../lib/monaco";

// growth budget past the natural column width before horizontal scrolling
const MAX_EXPAND = 320;

// smallest single-range edit turning oldStr into newStr (offsets) — the
// model keeps tokens for unchanged lines instead of retokenizing everything
// on each streaming delta
function diffOffsets(
  oldStr: string,
  newStr: string,
): { start: number; end: number; insert: string } | null {
  if (oldStr === newStr) return null;
  let start = 0;
  const maxStart = Math.min(oldStr.length, newStr.length);
  while (start < maxStart && oldStr[start] === newStr[start]) start++;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { start, end: oldEnd, insert: newStr.slice(start, newEnd) };
}

// read-only monaco block — shared renderer for diffs, fences and tool
// outputs. Loads the chunk lazily, syncs content incrementally (streaming
// safe), paints cheap lines synchronously (no idle-queue color pop-in),
// auto-heights up to maxHeight, widens into free stage space, and degrades
// to `fallback` (silently + console.error) if monaco ever fails — a viewer
// must never blank the chat, there is no error boundary above it.
export default function MonacoBlock({
  value,
  language,
  fontSize = 12,
  lineHeight = 19,
  padTop = 6,
  padBottom = 6,
  leftPad = 10,
  tabSize = 8,
  wrap = false,
  maxHeight = Infinity,
  expandWidth = true,
  className = "",
  fallback,
  gutter,
  decorate,
}: {
  value: string;
  language: string;
  fontSize?: number;
  lineHeight?: number;
  padTop?: number;
  padBottom?: number;
  leftPad?: number;
  tabSize?: number;
  wrap?: boolean;
  maxHeight?: number;
  expandWidth?: boolean;
  className?: string;
  fallback: ReactNode;
  gutter?: (n: number) => string;
  decorate?: (model: Monaco.editor.ITextModel, mod: typeof Monaco) => Monaco.editor.IModelDeltaDecoration[];
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decosRef = useRef<string[]>([]);
  const [mod, setMod] = useState<typeof Monaco | null>(null);
  const [fail, setFail] = useState<string | null>(null);

  // creation reads these so the editor is born with full content (no
  // empty→fill transition for height to get stuck on)
  const valueRef = useRef(value);
  valueRef.current = value;
  const langRef = useRef(language);
  langRef.current = language;
  const gutterRef = useRef(gutter);
  gutterRef.current = gutter;
  const maxHeightRef = useRef(maxHeight);
  maxHeightRef.current = maxHeight;
  const fitRef = useRef<(() => void) | null>(null);
  const longestLine = useMemo(() => {
    let best = "";
    for (const l of value.split("\n")) if (l.length > best.length) best = l;
    return best;
  }, [value]);
  // first paint must be colored: wait for the language grammar before
  // creating (fallback shows meanwhile — same shape, no layout shift).
  // Only gates first creation; later updates flow through the sync effect.
  const [gramReady, setGramReady] = useState(false);

  const failWith = (stage: string, e: unknown) => {
    try {
      console.error(`[monaco-block] ${stage}:`, e instanceof Error ? e.message : e);
    } catch {}
    setFail(stage);
  };

  // grow toward the longest line when free stage space allows — capped at
  // MAX_EXPAND past the natural width and never past the scroller, so the
  // chat itself never gains a horizontal scrollbar. Wrapped blocks normally
  // need nothing (wrapping absorbs overflow); only unbreakable spill grows
  // them, by exactly the spilled amount (never the full unwrapped estimate).
  // Hysteresis throughout (grow past +16, shrink back only with 32+ spare)
  // so streaming never flickers the width, and layout runs only on change.
  const applyWidth = useCallback(() => {
    const box = mountRef.current;
    if (!box || !box.isConnected) return;
    const natural = box.parentElement?.clientWidth || box.clientWidth;
    const ed = edRef.current;
    let wrapSpill: number | null = null;
    if (wrap) {
      let clear = true;
      if (ed) {
        try {
          const li = ed.getLayoutInfo();
          const slack = li.width - li.contentLeft - ed.getScrollWidth();
          if (slack < -2) {
            clear = false;
            wrapSpill = Math.ceil(li.contentLeft + ed.getScrollWidth() + 14);
          } else if (slack <= 32) return; // deadband: keep current width
        } catch {}
      }
      if (clear) {
        if (box.style.width) {
          box.style.width = "";
          try {
            ed?.layout();
          } catch {}
        }
        return;
      }
    }
    let needed =
      wrapSpill ?? Math.ceil(leftPad + 8 + measureLineWidth(longestLine, fontSize, tabSize) + 14);
    if (ed && wrapSpill == null) {
      try {
        const li = ed.getLayoutInfo();
        needed = Math.max(needed, Math.ceil(li.contentLeft + ed.getScrollWidth() + 14));
      } catch {}
    }
    let avail = natural + MAX_EXPAND;
    const scroller = box.closest(".messages, .dlg-body");
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      const pr = parseFloat(getComputedStyle(scroller).paddingRight || "0") || 0;
      avail = Math.floor(sr.right - br.left - pr - 4);
    }
    const target = Math.min(needed, Math.min(natural + MAX_EXPAND, avail));
    if (target > natural + 16) {
      const v = `${Math.floor(target)}px`;
      if (box.style.width !== v) {
        box.style.width = v;
        try {
          ed?.layout();
        } catch {}
      }
    } else if (box.style.width) {
      box.style.width = "";
      try {
        ed?.layout();
      } catch {}
    }
  }, [longestLine, wrap, fontSize, leftPad, tabSize]);

  useEffect(() => {
    if (expandWidth) applyWidth();
  }, [applyWidth, expandWidth]);
  useEffect(() => {
    if (!expandWidth) return;
    window.addEventListener("resize", applyWidth);
    return () => window.removeEventListener("resize", applyWidth);
  }, [applyWidth, expandWidth]);
  // webfont swaps change glyph advances after measure — re-fit once fonts
  // settle so late-loading JetBrains Mono can't leave lines scrolling
  useEffect(() => {
    if (!expandWidth) return;
    let dead = false;
    try {
      document.fonts?.ready
        .then(() => {
          if (!dead) applyWidth();
        })
        .catch(() => {});
    } catch {}
    return () => {
      dead = true;
    };
  }, [applyWidth, expandWidth]);

  useEffect(() => {
    let dead = false;
    void loadMonaco().then(
      (m) => {
        if (!dead) setMod(m);
      },
      (e) => {
        if (!dead) failWith("load", e);
      },
    );
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // create once monaco arrives AND the grammar is live; height follows
  // content up to maxHeight, then the block scrolls internally
  useEffect(() => {
    if (!mod || fail || edRef.current || !mountRef.current) return;
    if (!gramReady) return;
    let ed: Monaco.editor.IStandaloneCodeEditor | null = null;
    let sizeSub: Monaco.IDisposable | null = null;
    try {
      defineGuiTheme(mod);
      ed = mod.editor.create(mountRef.current, {
        theme: MONACO_THEME,
        value: valueRef.current,
        language: langRef.current,
        readOnly: true,
        fontFamily: MONO_STACK,
        fontSize,
        lineHeight,
        fontLigatures: false,
        tabSize,
        wordWrap: wrap ? "on" : "off",
        minimap: { enabled: false },
        lineNumbers: gutterRef.current ?? "off",
        lineNumbersMinChars: 1,
        glyphMargin: false,
        folding: false,
        showFoldingControls: "never",
        lineDecorationsWidth: leftPad,
        padding: { top: padTop, bottom: padBottom },
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
        ariaLabel: "Code",
      });
      edRef.current = ed;
      const fit = () => {
        const el = mountRef.current;
        if (!el || !ed) return;
        el.style.height = `${Math.min(ed.getContentHeight(), maxHeightRef.current)}px`;
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
      failWith("create", e);
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
    // font metrics are static per usage — read at construction
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod, fail, gramReady]);

  // wait for the language grammar before first creation — later language
  // changes flow through setModelLanguage in the sync effect (no remount)
  useEffect(() => {
    if (!mod || fail || edRef.current) return;
    let dead = false;
    setGramReady(false);
    void whenGrammarReady(mod, langRef.current).then(() => {
      if (!dead) setGramReady(true);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod, fail, language]);

  // content/language updates (streaming safe): incremental edit, language
  // only when changed, synchronous paint for cheap lines, then decorations
  // + explicit refit + width
  useEffect(() => {
    const ed = edRef.current;
    if (!ed || !mod || fail) return;
    try {
      const model = ed.getModel();
      if (!model) return;
      const cur = model.getValue();
      if (cur !== value) {
        const d = diffOffsets(cur, value);
        if (d) {
          const s = model.getPositionAt(d.start);
          const e = model.getPositionAt(d.end);
          ed.executeEdits("mono-sync", [{
            range: new mod.Range(s.lineNumber, s.column, e.lineNumber, e.column),
            text: d.insert,
          }]);
        }
      }
      if (model.getLanguageId() !== language) mod.editor.setModelLanguage(model, language);
      forceCheapTokens(model);
      const decos = decorate ? decorate(model, mod) : [];
      decosRef.current = ed.deltaDecorations(decosRef.current, decos);
      try {
        fitRef.current?.();
      } catch {}
      if (expandWidth) applyWidth();
      // layout settles async (fonts, virtualized rows) — re-check once next
      // frame with fresh scroll metrics so a stale first measure can't stick
      if (expandWidth) {
        requestAnimationFrame(() => {
          try {
            fitRef.current?.();
          } catch {}
          try {
            applyWidth();
          } catch {}
        });
      }
    } catch (e) {
      try {
        ed.dispose();
      } catch {}
      edRef.current = null;
      decosRef.current = [];
      failWith("sync", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod, value, language, decorate, fail, applyWidth, expandWidth]);

  if (!mod || fail || !gramReady) return fallback;
  return <div ref={mountRef} className={className} />;
}
