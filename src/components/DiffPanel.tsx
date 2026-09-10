import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { Msg } from "../types";
import { opencode, opencodeFor } from "../api";
import { extLang } from "../lib/syntax";
import { hlToMonacoLang } from "../lib/monaco";
import Dialog from "./Dialog";
import MonacoBlock from "./MonacoBlock";
import "../styles/diff.css";

type FileDiff = {
  file: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: string;
  before?: string;
  after?: string;
};

export default function DiffPanel({
  sessionId,
  dir,
  onClose,
}: {
  sessionId: string;
  dir?: string;
  onClose: () => void;
}) {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState("");
  // the dialog stays mounted across session switches — generation-guard the
  // fetch so a slow response for the previous session can never overwrite
  // (or error-clear into) the current one
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    // never show the previous session's list (or its error) while loading
    setDiffs(null);
    setError("");
    (async () => {
      try {
        const { client } = dir ? await opencodeFor(dir) : await opencode();
        // the endpoint returns [] without a messageID — it serves each USER
        // message's precomputed summary.diffs; merge across the whole session
        // (later prompts win for the same file)
        const r = await client.session.messages({ path: { id: sessionId } });
        if (genRef.current !== gen) return;
        const msgs = ((r.data ?? []) as unknown as Msg[]) || [];
        const byFile = new Map<string, FileDiff>();
        for (const m of msgs) {
          if (m.info.role !== "user") continue;
          const list = ((m.info as any).summary?.diffs ?? []) as FileDiff[];
          for (const d of list) byFile.set(d.file, d);
        }
        const list = [...byFile.values()];
        setDiffs(list);
        window.dispatchEvent(
          new CustomEvent("oc:diff-files", { detail: { sessionId, files: list.map((d) => d.file) } }),
        );
      } catch (e) {
        if (genRef.current !== gen) return;
        setError(String(e));
      }
    })();
  }, [sessionId, dir]);

  return (
    <Dialog title="Changes in this session" onClose={onClose} stage>
      {error && <p className="empty">{error}</p>}
      {!error && diffs === null && <p className="empty">Loading…</p>}
      {diffs?.length === 0 && (
        <p className="empty">
          No tracked changes yet — snapshots need a Git repository
          as the server's working directory.
        </p>
      )}
      {diffs?.map((d) => (
        <div key={d.file} className="diff-file">
          <div className="diff-file-head">
            <span className="diff-path">{d.file}</span>
            <span className="diff-stat">
              <em>+{d.additions ?? 0}</em> <em className="del">-{d.deletions ?? 0}</em>
            </span>
          </div>
          <DiffLines patch={d.patch ?? ""} lang={extLang(d.file)} />
        </div>
      ))}
    </Dialog>
  );
}

// unified diff for a patch — read-only monaco rendering with the same
// rows/signs/tints as the old DOM version: +/- prefixes live in the sign
// gutter so token colors stay clean, diff-ness comes from gutter + row
// decorations over the file language
// (also reused by chat tool blocks for edit/write diffs, and the git panel)
type DiffRow = { cls: "add" | "del" | "ctx" | "hunk"; sign: string; text: string };

function parsePatch(patch: string): DiffRow[] {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const rows: DiffRow[] = [];
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

export function DiffLines({ patch, lang }: { patch: string; lang?: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const text = useMemo(() => rows.map((r) => r.text).join("\n"), [rows]);
  const signs = useMemo(() => rows.map((r) => r.sign), [rows]);
  // whole-line background + inline text color per row (plain text takes the
  // row color, token spans keep theirs); ranges from string lengths only
  const decorate = useCallback(
    (_model: Monaco.editor.ITextModel, mod: typeof Monaco) => {
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
      return decos;
    },
    [rows],
  );
  const fallback = (
    <div className="diff-lines mono ro-fallback">
      {rows.map((r, i) => (
        <div key={i} className={r.cls}>
          <span className="sign">{r.sign}</span>
          {r.text}
        </div>
      ))}
    </div>
  );
  if (!patch.trim()) return null;
  return (
    <MonacoBlock
      value={text}
      language={hlToMonacoLang(lang)}
      maxHeight={420}
      className="ro-diff"
      gutter={(n) => signs[n - 1] ?? " "}
      decorate={decorate}
      fallback={fallback}
    />
  );
}
