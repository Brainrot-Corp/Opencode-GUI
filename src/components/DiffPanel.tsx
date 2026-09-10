import { useEffect, useState } from "react";
import type { Msg } from "../types";
import { opencode } from "../api";
import { extLang } from "../lib/syntax";
import Dialog from "./Dialog";
import ReadOnlyDiff from "./ReadOnlyDiff";
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
        const list = [...byFile.values()];
        setDiffs(list);
        window.dispatchEvent(new CustomEvent("oc:diff-files", { detail: list.map((d) => d.file) }));
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [sessionId]);

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
// rows/signs/tints as the old DOM version
// (also reused by chat tool blocks for edit/write diffs)
export function DiffLines({ patch, lang }: { patch: string; lang?: string }) {
  if (!patch.trim()) return null;
  return <ReadOnlyDiff patch={patch} lang={lang} />;
}
