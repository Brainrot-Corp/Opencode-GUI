import { useContext, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PartCtx } from "../ToolBlock";
import { extractChanged } from "../../lib/changedFiles";
import { isRemoteDir } from "../../lib/remotes";

// per-response "changed:" line built from this message's own tool calls
// (write/edit + raw bash command) instead of the server git-diff patch part.
export default function ChangedLine({ parts }: { parts: any[] }) {
  const { dir } = useContext(PartCtx);
  const [busy, setBusy] = useState(false);
  const entries = useMemo(() => extractChanged(parts), [parts]);
  if (!entries.length) return null;
  const files = entries.filter((e) => e.kind === "file").map((e) => (e as { path: string }).path);
  // git-only: remote SSH workspaces have no local repo for git_discard
  const canRevert = files.length > 0 && !busy && !isRemoteDir(dir ?? "");
  const doRevert = async () => {
    if (!files.length || busy) return;
    if (!window.confirm(`Discard changes to ${files.length} file(s)?\n${files.join("\n")}\n\nThis cannot be undone.`)) return;
    setBusy(true);
    try {
      await invoke("git_discard", { dir: dir ?? "", paths: files });
    } catch {
      // git panel surfaces the error on its next refresh; stay silent here
    } finally {
      setBusy(false);
    }
  };
  const openFile = (path: string) =>
    window.dispatchEvent(new CustomEvent("oc:open-file", { detail: { path, dir } }));
  return (
    <div className="patch-line">
      <i className="fa-solid fa-code-pull-request" />
      changed:
      {entries.map((e, i) =>
        e.kind === "file" ? (
          <span
            key={`f${i}:${e.path}`}
            role="button"
            tabIndex={0}
            className="mono patch-file"
            data-tip={e.path}
            onClick={() => openFile(e.path)}
            onKeyDown={(ev) => {
              if (ev.key !== "Enter") return;
              ev.preventDefault();
              openFile(e.path);
            }}
          >
            {e.path.split(/[\\/]/).pop() || e.path}
          </span>
        ) : (
          <span key={`b${i}:${e.command}`} className="mono patch-file" data-tip={e.command}>
            {e.command.length > 90 ? `${e.command.slice(0, 90)}…` : e.command}
          </span>
        ),
      )}
      {canRevert && (
        <button
          type="button"
          className="tool-eye"
          data-tip="Revert these files (git discard)"
          aria-label="Revert changed files"
          onClick={(e) => {
            e.stopPropagation();
            void doRevert();
          }}
        >
          <i className="fa-solid fa-clock-rotate-left" />
        </button>
      )}
    </div>
  );
}
