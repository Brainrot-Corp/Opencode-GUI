import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Msg } from "../types";
import { opencode } from "../api";
import { extLang, hlHtml } from "../lib/syntax";
import Dialog from "./Dialog";
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
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { client } = await opencode();
        // the endpoint returns [] without a messageID — it serves each USER
        // message's precomputed summary.diffs; merge across the whole session
        // (later prompts win for the same file)
        const r = await client.session.messages({ path: { id: sessionId } });
        const msgs = ((r.data ?? []) as unknown as Msg[]) || [];
        const byFile = new Map<string, FileDiff>();
        for (const m of msgs) {
          if (m.info.role !== "user") continue;
          const list = ((m.info as any).summary?.diffs ?? []) as FileDiff[];
          for (const d of list) byFile.set(d.file, d);
        }
        setDiffs([...byFile.values()]);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [sessionId]);

  return (
    <Dialog title="Changes in this session" onClose={onClose} wide>
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

// colorize the server-provided unified diff: runs of add/del/context lines
// are highlighted as one block (so multi-line tokens stay consistent), then
// re-split by line; hunk and file headers keep their plain styling
// (also reused by chat tool blocks for edit/write diffs)
export function DiffLines({ patch, lang }: { patch: string; lang?: string }) {
  if (!patch.trim()) return null;
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const out: ReactNode[] = [];
  let buf: { cls: string; sign: string; code: string }[] = [];
  const flush = () => {
    if (!buf.length) return;
    const html = lang
      ? hlHtml(buf.map((b) => b.code).join("\n"), lang).split("\n")
      : null;
    for (const b of buf)
      out.push(
        <div key={out.length} className={b.cls}>
          <span className="sign">{b.sign}</span>
          {html ? <span dangerouslySetInnerHTML={{ __html: html.shift() ?? "" }} /> : b.code}
        </div>,
      );
    buf = [];
  };

  for (const l of lines) {
    if (l.startsWith("@@")) {
      flush();
      out.push(
        <div key={out.length} className="hunk">
          {l}
        </div>,
      );
      continue;
    }
    if (/^(---|\+\+\+|diff |index |old mode|new mode)/.test(l)) {
      flush();
      out.push(
        <div key={out.length} className="ctx meta">
          {l}
        </div>,
      );
      continue;
    }
    const cls = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
    const sign = cls === "add" ? "+" : cls === "del" ? "-" : " ";
    // strip the diff prefix so it doesn't pollute the first token
    const code = cls === "ctx" ? (l.startsWith(" ") ? l.slice(1) : l) : l.slice(1);
    buf.push({ cls, sign, code });
  }
  flush();

  return <div className="diff-lines mono">{out}</div>;
}
