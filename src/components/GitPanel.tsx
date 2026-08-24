import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory } from "../api";
import { extLang } from "../lib/syntax";
import Dialog from "./Dialog";
import { DiffLines } from "./DiffPanel";
import "../styles/git.css";

type GitFile = { path: string; x: string; y: string };
type GitStatus = {
  repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
};

const CLEAN: GitStatus = { repo: false, branch: "", ahead: 0, behind: 0, files: [] };

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// staged = index column meaningful; changes = worktree column or untracked
const stagedOf = (files: GitFile[]) => files.filter((f) => f.x !== " " && f.x !== "?");
const changedOf = (files: GitFile[]) => files.filter((f) => f.y !== " ");

// status letter → css tint class (M/A/D colored like VS Code, rest dim)
const xcls = (l: string) =>
  l === "M" ? "mod" : l === "A" ? "add" : l === "D" ? "del" : l === "U" ? "conf" : "oth";

export default function GitPanel() {
  const [st, setSt] = useState<GitStatus>(CLEAN);
  const [open, setOpen] = useState(() => localStorage.getItem("oc.git.open") === "1");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmPath, setConfirmPath] = useState(""); // discard two-step
  const [diff, setDiff] = useState<{ path: string; patch: string; staged: boolean } | null>(null);
  const dir = useRef(getDirectory());

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<GitStatus>("git_status", { dir: dir.current });
      setSt(s);
    } catch {
      setSt(CLEAN);
    }
  }, []);

  // one serialized wrapper for every mutating action: run, refresh, surface
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setErr("");
      try {
        await fn();
        await refresh();
      } catch (e) {
        setErr(String(e).replace(/^Error:\s*/, ""));
      }
      setBusy(false);
    },
    [busy, refresh],
  );

  const commit = (thenPush = false) =>
    act(async () => {
      await invoke("git_commit", { dir: dir.current, message: msg.trim() });
      setMsg(""); // committed even if a chained push fails
      if (thenPush) await invoke("git_push", { dir: dir.current });
    });

  const rowAct = (cmd: string, path: string) => {
    setConfirmPath("");
    return act(() => invoke(cmd, { dir: dir.current, paths: [path] }));
  };

  const openDiff = async (f: GitFile, isStaged: boolean) => {
    const patch = await invoke<string>("git_diff", {
      dir: dir.current,
      path: f.path,
      staged: isStaged,
    }).catch(() => "");
    setDiff({ path: f.path, patch, staged: isStaged });
  };

  // initial status + poll while expanded + refresh on window focus
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!open || !st.repo) return;
    refresh();
    const t = setInterval(refresh, 4000);
    const onVis = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onVis);
    };
  }, [open, st.repo, refresh]);

  if (!st.repo)
    return (
      <div className="git-panel">
        <div className="gp-head gp-none">
          <i className="fa-solid fa-code-branch" />
          <span>No git repository</span>
        </div>
      </div>
    );

  const staged = stagedOf(st.files);
  const changes = changedOf(st.files);
  const canCommit = !!msg.trim() && staged.length > 0 && !busy;

  const toggleOpen = () => {
    setOpen((o) => {
      localStorage.setItem("oc.git.open", o ? "0" : "1");
      return !o;
    });
  };

  const row = (f: GitFile, isStaged: boolean) => {
    const letter = isStaged ? f.x : f.y;
    const untracked = f.x === "?" && f.y === "?";
    const confirming = confirmPath === f.path;
    return (
      <div key={f.path + (isStaged ? "~s" : "~w")} className={`gp-row${confirming ? " confirming" : ""}`}>
        <span className={`gp-x ${xcls(letter)} mono`}>{letter}</span>
        <button
          className="gp-file mono"
          data-tip={f.path}
          onClick={() => !untracked && openDiff(f, isStaged)}
          disabled={untracked}
        >
          {base(f.path)}
        </button>
        <span className="gp-acts">
          {confirming ? (
            <>
              <button className="gp-act danger" data-tip="Really discard" onClick={() => rowAct("git_discard", f.path)}>
                <i className="fa-solid fa-check" />
              </button>
              <button className="gp-act" data-tip="Keep" onClick={() => setConfirmPath("")}>
                <i className="fa-solid fa-xmark" />
              </button>
            </>
          ) : (
            <>
              {isStaged ? (
                <button className="gp-act" data-tip="Unstage" onClick={() => rowAct("git_unstage", f.path)}>
                  <i className="fa-solid fa-minus" />
                </button>
              ) : (
                <button className="gp-act" data-tip="Stage" onClick={() => rowAct("git_stage", f.path)}>
                  <i className="fa-solid fa-plus" />
                </button>
              )}
              {!isStaged && !untracked && (
                <button
                  className="gp-act"
                  data-tip="Discard changes"
                  onClick={() => setConfirmPath(f.path)}
                >
                  <i className="fa-solid fa-rotate-left" />
                </button>
              )}
            </>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="git-panel">
      <button className="gp-head" onClick={toggleOpen} data-tip={open ? "Collapse git" : "Expand git"}>
        <i className={`fa-solid fa-chevron-${open ? "down" : "right"} gp-chev`} />
        <i className="fa-solid fa-code-branch" />
        <span className="mono">{st.branch}</span>
        {(st.ahead > 0 || st.behind > 0) && (
          <span className="gp-ab mono">
            {st.ahead > 0 && (
              <em>
                ↑{st.ahead}
              </em>
            )}
            {st.behind > 0 && <em className="down">↓{st.behind}</em>}
          </span>
        )}
        {!!st.files.length && <span className="gp-badge">{st.files.length}</span>}
      </button>

      {open && (
        <div className="gp-body">
          <input
            className="gp-msg"
            placeholder={`Message (${staged.length} staged)`}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canCommit && commit(false)}
            disabled={busy}
          />
          <div className="gp-actions">
            <button data-tip="Commit staged" disabled={!canCommit} onClick={() => commit(false)}>
              <i className="fa-solid fa-check" />
              Commit
            </button>
            <button data-tip="Commit staged and push" disabled={!canCommit} onClick={() => commit(true)}>
              <i className="fa-solid fa-check-double" />
              Commit + Push
            </button>
            <button data-tip="Push" disabled={busy || (!st.ahead && !staged.length)} onClick={() => act(() => invoke("git_push", { dir: dir.current }))}>
              <i className="fa-solid fa-arrow-up" />
              Push
            </button>
            <button data-tip="Pull" disabled={busy} onClick={() => act(() => invoke("git_pull", { dir: dir.current }))}>
              <i className="fa-solid fa-arrow-down" />
              Pull
            </button>
          </div>
          {err && <div className="gp-err mono">{err}</div>}

          {staged.length > 0 && (
            <>
              <div className="gp-sect">Staged</div>
              {staged.map((f) => row(f, true))}
            </>
          )}
          <div className="gp-sect">Changes</div>
          {changes.length === 0 && <div className="gp-empty">Working tree clean</div>}
          {changes.map((f) => row(f, false))}
        </div>
      )}

      {diff && (
        <Dialog title={`${base(diff.path)} — ${diff.staged ? "staged" : "working tree"} diff`} onClose={() => setDiff(null)} wide>
          {diff.patch.trim() ? (
            <DiffLines patch={diff.patch} lang={extLang(diff.path)} />
          ) : (
            <p className="empty">No diff — new file or no unstaged edits.</p>
          )}
        </Dialog>
      )}
    </div>
  );
}
