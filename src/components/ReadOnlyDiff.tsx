import { useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import {
  MONACO_THEME,
  MONO_STACK,
  defineGuiTheme,
  hlToMonacoLang,
  loadMonaco,
} from "../lib/monaco";

type Row = { cls: "add" | "del" | "ctx" | "hunk"; sign: string; text: string };

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
  const edRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decosRef = useRef<string[]>([]);
  const [mod, setMod] = useState<typeof Monaco | null>(null);

  const rows = useMemo(() => parsePatch(patch), [patch]);
  const text = useMemo(() => rows.map((r) => r.text).join("\n"), [rows]);
  const signs = useMemo(() => rows.map((r) => r.sign), [rows]);
  const signsRef = useRef(signs);
  signsRef.current = signs;

  useEffect(() => {
    let dead = false;
    void loadMonaco().then((m) => {
      if (!dead) setMod(m);
    });
    return () => {
      dead = true;
    };
  }, []);

  // create once monaco arrives; height follows content so the block grows
  // with the patch instead of scrolling internally (page keeps scrolling)
  useEffect(() => {
    if (!mod || edRef.current || !mountRef.current) return;
    defineGuiTheme(mod);
    const ed = mod.editor.create(mountRef.current, {
      theme: MONACO_THEME,
      value: "",
      language: hlToMonacoLang(lang),
      readOnly: true,
      fontFamily: MONO_STACK,
      fontSize: 12,
      lineHeight: 19,
      fontLigatures: false,
      tabSize: 2,
      wordWrap: "off",
      minimap: { enabled: false },
      lineNumbers: () => " ",
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
      scrollbar: {
        vertical: "hidden",
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
      if (!el) return;
      el.style.height = `${ed.getContentHeight()}px`;
      try {
        ed.layout();
      } catch {}
    };
    const sizeSub = ed.onDidContentSizeChange(fit);
    fit();
    return () => {
      sizeSub.dispose();
      edRef.current = null;
      decosRef.current = [];
      const m = ed.getModel();
      ed.dispose();
      m?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod]);

  // patch/language updates (streaming tool output): sync text, gutter signs,
  // language and row decorations — height follows via contentSizeChange
  useEffect(() => {
    const ed = edRef.current;
    if (!ed || !mod) return;
    const model = ed.getModel();
    if (!model) return;
    if (model.getValue() !== text) {
      ed.executeEdits("diff-update", [{ range: model.getFullModelRange(), text }]);
    }
    const cur = signsRef.current;
    ed.updateOptions({ lineNumbers: (n: number) => cur[n - 1] ?? " " });
    mod.editor.setModelLanguage(model, hlToMonacoLang(lang));
    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    rows.forEach((r, i) => {
      const ln = i + 1;
      if (r.cls === "add") {
        decos.push({
          range: new mod.Range(ln, 1, ln, 1),
          options: { isWholeLine: true, className: "ro-row ro-add" },
        });
        if (r.text)
          decos.push({
            range: new mod.Range(ln, 1, ln, model.getLineMaxColumn(ln)),
            options: { inlineClassName: "ro-add-inline" },
          });
      } else if (r.cls === "del") {
        decos.push({
          range: new mod.Range(ln, 1, ln, 1),
          options: { isWholeLine: true, className: "ro-row ro-del" },
        });
        if (r.text)
          decos.push({
            range: new mod.Range(ln, 1, ln, model.getLineMaxColumn(ln)),
            options: { inlineClassName: "ro-del-inline" },
          });
      } else if (r.cls === "hunk") {
        if (r.text)
          decos.push({
            range: new mod.Range(ln, 1, ln, model.getLineMaxColumn(ln)),
            options: { inlineClassName: "ro-hunk-inline" },
          });
      } else {
        decos.push({
          range: new mod.Range(ln, 1, ln, 1),
          options: { isWholeLine: true, className: "ro-row ro-ctx" },
        });
      }
    });
    decosRef.current = ed.deltaDecorations(decosRef.current, decos);
  }, [mod, rows, text, lang]);

  // monaco chunk still loading — plain rows, no highlight (same shape, so no
  // layout jump when the editor takes over)
  if (!mod) {
    if (!patch.trim()) return null;
    return (
      <div className="diff-lines mono">
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
