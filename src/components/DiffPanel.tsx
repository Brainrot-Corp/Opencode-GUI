import { useEffect, useState } from "react";
import type { Msg } from "../types";
import { opencode } from "../api";
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
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

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
    <div className="diff-scrim" onClick={onClose}>
      <div className="diff-panel" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="diff-head">
          <span>Changes in this session</span>
          <button className="icon-btn diff-close" title="Close" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="diff-body">
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
              <DiffLines patch={d.patch ?? ""} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// colorize the server-provided unified diff
function DiffLines({ patch }: { patch: string }) {
  if (!patch.trim()) return null;
  return (
    <div className="diff-lines mono">
      {patch.split("\n").map((l, i) => {
        const cls =
          l.startsWith("+") && !l.startsWith("+++")
            ? "add"
            : l.startsWith("-") && !l.startsWith("---")
              ? "del"
              : l.startsWith("@@")
                ? "hunk"
                : "ctx";
        return (
          <div key={i} className={cls}>
            {l}
          </div>
        );
      })}
    </div>
  );
}
