import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, opencode } from "../api";
import { splitModel } from "../lib/models";
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

// secondary model from the settings blob — read at click time so
// drawer edits apply without remounting (same pattern as api.ts workspace)
function secondaryModel(): string {
  try {
    const v = JSON.parse(localStorage.getItem("oc.settings") ?? "{}").secondaryModel;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

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
  const [gen, setGen] = useState(false); // AI message in flight
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

  // one serialized wrapper for every mutating action: run, ALWAYS refresh
  // (even on failure — e.g. commit-ok/push-fail must reconcile), surface
  // errors; returns whether it succeeded
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return false;
      setBusy(true);
      setErr("");
      let ok = true;
      try {
        await fn();
      } catch (e) {
        setErr(String(e).replace(/^Error:\s*/, ""));
        ok = false;
      }
      await refresh();
      setBusy(false);
      return ok;
    },
    [busy, refresh],
  );

  const commit = (thenPush = false) =>
    act(async () => {
      await invoke("git_commit", { dir: dir.current, message: msg.trim() });
      // committed entries leave the lists immediately — don't wait for the
      // status roundtrip (a chained push failing must not resurrect them)
      setSt((s) => ({
        ...s,
        files: s.files.filter((f) => f.x === " " || f.x === "?"),
      }));
      setMsg("");
      if (thenPush) await invoke("git_push", { dir: dir.current });
    });

  // push with visible progress: spinner while running, check + glow briefly
  // once confirmed
  const [pushed, setPushed] = useState<"idle" | "run" | "ok">("idle");
  const doPush = async () => {
    if (pushed !== "idle") return;
    setPushed("run");
    const ok = await act(() => invoke("git_push", { dir: dir.current }));
    setPushed(ok ? "ok" : "idle");
  };
  useEffect(() => {
    if (pushed !== "ok") return;
    const t = setTimeout(() => setPushed("idle"), 1800);
    return () => clearTimeout(t);
  }, [pushed]);

  // AI commit message: hidden temp session on the configured model —
  // created, prompted (sync), deleted; never touches the sidebar list
  const genMsg = async () => {
    const model = secondaryModel();
    if (!model) {
      // nothing configured — jump straight to the settings drawer
      window.dispatchEvent(new Event("oc:settings"));
      setErr("Pick a Secondary model in Settings.");
      return;
    }
    if (gen || busy || !staged.length) return;
    setGen(true);
    setErr("");
    try {
      const diff = await invoke<string>("git_diff", { dir: dir.current, path: "", staged: true });
      if (!diff.trim()) {
        setErr("Staged diff is empty.");
        return;
      }
      const { client } = await opencode();
      const s = await client.session.create({ body: {} });
      const sid = (s.data as any).id;
      try {
        const [providerID, modelID] = splitModel(model);
        // secondary tasks use low thinking effort if the model supports it
        let variant: string | undefined;
        try {
          const pr: any = await client.config.providers();
          const prov = (pr.data?.providers ?? []).find((p: any) => p.id === providerID);
          const vars = Object.keys(prov?.models?.[modelID]?.variants ?? {});
          if (vars.includes("low")) variant = "low";
          else if (vars.includes("minimal")) variant = "minimal";
          else if (vars.includes("fast")) variant = "fast";
        } catch {}
        const r = await client.session.prompt({
          path: { id: sid },
          body: {
            parts: [
              {
                type: "text",
                text:
                  "Write a git commit message for this staged diff. One line, " +
                  "imperative mood, max 72 chars, no backticks or quotes — reply " +
                  "with ONLY the message.\n\n" +
                  diff.slice(0, 12000),
              },
            ],
            model: { providerID, modelID },
            ...(variant ? { variant } : {}),
          },
        });
        const parts: any[] = ((r.data as any)?.parts ?? []) as any[];
        const text = parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        if (text) setMsg(text);
        else setErr("Model returned no message.");
      } finally {
        await client.session.delete({ path: { id: sid } }).catch(() => {});
      }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
    setGen(false);
  };

  const rowAct = (cmd: string, path: string) => {
    setConfirmPath("");
    return act(() => invoke(cmd, { dir: dir.current, paths: [path] }));
  };

  // bulk revert — tracked files only; untracked need `git clean`, not restore
  const discardAll = () => {
    const paths = changes
      .filter((f) => !(f.x === "?" && f.y === "?"))
      .map((f) => f.path);
    return act(() =>
      invoke("git_discard", { dir: dir.current, paths }),
    ).then(() => setConfirmPath(""));
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
          <div className="gp-msgrow">
            <input
              className="gp-msg"
              placeholder={`Message (${staged.length} staged)`}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canCommit && commit(false)}
              disabled={busy}
            />
            <button
              className={`gp-gen${gen ? " spinning" : ""}`}
              data-tip={
                secondaryModel()
                  ? `Generate message (${secondaryModel()})`
                  : "Pick a Secondary model in Settings"
              }
              disabled={gen || busy || !staged.length}
              onClick={genMsg}
            >
              <i className="fa-solid fa-wand-magic-sparkles" />
            </button>
          </div>
          <div className="gp-actions">
            <button data-tip="Commit staged" disabled={!canCommit} onClick={() => commit(false)}>
              <i className="fa-solid fa-check" />
              Commit
            </button>
            <button data-tip="Commit staged and push" disabled={!canCommit} onClick={() => commit(true)}>
              <i className="fa-solid fa-check-double" />
              Commit + Push
            </button>
            <button
              className={`push${pushed === "ok" ? " pushed" : ""}`}
              data-tip="Push to remote"
              disabled={busy || pushed === "run" || (!st.ahead && !staged.length)}
              onClick={doPush}
            >
              <i
                className={`fa-solid ${
                  pushed === "run"
                    ? "fa-spinner fa-spin-pulse"
                    : pushed === "ok"
                      ? "fa-check"
                      : "fa-arrow-up"
                }`}
              />
              {pushed === "ok" ? "Pushed" : "Push"}
            </button>
            <button data-tip="Pull" disabled={busy} onClick={() => act(() => invoke("git_pull", { dir: dir.current }))}>
              <i className="fa-solid fa-arrow-down" />
              Pull
            </button>
          </div>
          {err && <div className="gp-err mono">{err}</div>}

          {staged.length > 0 && (
            <>
              <div className="gp-sect">
                <span>Staged</span>
                <button
                  className="gp-sact"
                  data-tip="Unstage all"
                  disabled={busy}
                  onClick={() => act(() => invoke("git_unstage", { dir: dir.current, paths: staged.map((f) => f.path) }))}
                >
                  <i className="fa-solid fa-minus" />
                  Unstage all
                </button>
              </div>
              {staged.map((f) => row(f, true))}
            </>
          )}
          <div className="gp-sect">
            <span>Changes</span>
            <span className="gp-sect-acts">
              {!!changes.length && (
                <>
                  <button
                    className="gp-sact"
                    data-tip="Stage all"
                    disabled={busy}
                    onClick={() => act(() => invoke("git_stage", { dir: dir.current, paths: changes.map((f) => f.path) }))}
                  >
                    <i className="fa-solid fa-plus" />
                    Stage all
                  </button>
                  {/* revert-all: tracked files only — untracked need git clean */}
                  {changes.some((f) => !(f.x === "?" && f.y === "?")) &&
                    (confirmPath === "*" ? (
                      <>
                        <button
                          className="gp-sact danger"
                          data-tip="Really discard all"
                          disabled={busy}
                          onClick={discardAll}
                        >
                          <i className="fa-solid fa-check" />
                          Sure?
                        </button>
                        <button
                          className="gp-sact"
                          data-tip="Keep"
                          onClick={() => setConfirmPath("")}
                        >
                          <i className="fa-solid fa-xmark" />
                        </button>
                      </>
                    ) : (
                      <button
                        className="gp-sact"
                        data-tip="Discard all unstaged"
                        disabled={busy}
                        onClick={() => setConfirmPath("*")}
                      >
                        <i className="fa-solid fa-rotate-left" />
                        Revert all
                      </button>
                    ))}
                </>
              )}
            </span>
          </div>
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
