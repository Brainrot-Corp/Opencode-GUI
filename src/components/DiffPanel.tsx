import { useEffect, useState } from "react";
import type { FileDiff } from "@opencode-ai/sdk/client";
import { opencode } from "../api";
import "../styles/diff.css";

// ponytail: O(n·m) LCS on lines; bigger pairs render "too large" instead
function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 1_500_000) return [];
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(" " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push("-" + a[i++]);
    } else {
      out.push("+" + b[j++]);
    }
  }
  while (i < n) out.push("-" + a[i++]);
  while (j < m) out.push("+" + b[j++]);
  return out;
}

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
        const r = await client.session.diff({ path: { id: sessionId } });
        setDiffs(((r.data ?? []) as FileDiff[]) || []);
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
          {diffs?.length === 0 && <p className="empty">No files changed yet.</p>}
          {diffs?.map((d) => {
            const lines = lineDiff(d.before, d.after);
            return (
              <div key={d.file} className="diff-file">
                <div className="diff-file-head">
                  <span className="diff-path">{d.file}</span>
                  <span className="diff-stat">
                    <em>+{d.additions}</em> <em className="del">-{d.deletions}</em>
                  </span>
                </div>
                {lines.length === 0 ? (
                  <div className="diff-lines skip">File too large for inline diff.</div>
                ) : (
                  <div className="diff-lines mono">
                    {lines.map((l, i) => (
                      <div
                        key={i}
                        className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx"}
                      >
                        {l}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
