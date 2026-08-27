import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, opencode, tempSession, dropSession, withDeadline } from "../api";
import { splitModel } from "../lib/models";
import { extLang } from "../lib/syntax";
import { playSound } from "../lib/sounds";
import Dialog from "./Dialog";
import { DiffLines } from "./DiffPanel";
import "../styles/git.css";

const GH_KEY = "oc.git.h";
const GH_MIN = 120;
const GH_DEFAULT = 220;
const clampH = (h: number) =>
  Math.min(Math.max(GH_MIN, Math.floor(h)), Math.floor(window.innerHeight * 0.6));

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

// status letter → css tint class (VS Code-style: M/T amber, A green,
// D red, untracked green-U, conflicts purple, renames blue, rest dim)
const xcls = (l: string) =>
  l === "M" || l === "T"
    ? "mod"
    : l === "A" || l === "?"
      ? "add"
      : l === "D"
        ? "del"
        : l === "U"
          ? "conf"
          : l === "R" || l === "C"
            ? "ren"
            : "oth";

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
  const [gh, setGh] = useState(() => clampH(Number(localStorage.getItem(GH_KEY)) || GH_DEFAULT));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    localStorage.setItem(GH_KEY, String(gh));
  }, [gh]);
  const [stagedCollapsed, setStagedCollapsed] = useState(
    () => localStorage.getItem("oc.git.stagedCollapsed") === "1",
  );
  const [changesCollapsed, setChangesCollapsed] = useState(
    () => localStorage.getItem("oc.git.changesCollapsed") === "1",
  );
  useEffect(() => {
    localStorage.setItem("oc.git.stagedCollapsed", stagedCollapsed ? "1" : "0");
  }, [stagedCollapsed]);
  useEffect(() => {
    localStorage.setItem("oc.git.changesCollapsed", changesCollapsed ? "1" : "0");
  }, [changesCollapsed]);
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = gh;
      let lastTick = 0;
      setDragging(true);
      document.body.classList.add("gp-resizing");
      document.body.style.userSelect = "none";
      const move = (ev: MouseEvent) => {
        setGh(clampH(startH + (startY - ev.clientY)));
        const now = performance.now();
        if (now - lastTick > 70) {
          lastTick = now;
          playSound("resize");
        }
      };
      const up = () => {
        setDragging(false);
        document.body.classList.remove("gp-resizing");
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("blur", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("blur", up);
    },
    [gh],
  );
  const resetSize = useCallback(() => {
    setGh(GH_DEFAULT);
    playSound("click");
  }, []);

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

  const commit = (thenPush = false, override?: string) =>
    act(async () => {
      await invoke("git_commit", { dir: dir.current, message: (override ?? msg).trim() });
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
  // created, prompted (sync), deleted; never touches the sidebar list.
  // Resolves to the message (also placed in the input) or "" on failure —
  // voice "commit" chains it straight into git_commit
  const genMessage = async (): Promise<string> => {
    const model = secondaryModel();
    if (!model) {
      // nothing configured — jump straight to the settings drawer
      window.dispatchEvent(new Event("oc:settings"));
      setErr("Pick a Secondary model in Settings.");
      return "";
    }
    if (gen || busy || !staged.length) return "";
    setGen(true);
    setErr("");
    try {
      const diff = await invoke<string>("git_diff", { dir: dir.current, path: "", staged: true });
      if (!diff.trim()) {
        setErr("Staged diff is empty.");
        return "";
      }
      const { client } = await opencode();
      const sid = await tempSession();
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
        const r = await withDeadline(
          client.session.prompt({
            path: { id: sid },
            body: {
              parts: [
                {
                  type: "text",
                  text:
                    "You generate git commit messages. Study the staged diff below and " +
                    "produce exactly one commit subject line for it.\n\n" +
                    "Rules:\n" +
                    "- Conventional Commit style when the change type is clear " +
                    "(feat:/fix:/refactor:/docs:/chore:/test:/perf:); plain otherwise\n" +
                    "- Imperative mood, present tense (\"add\", never \"added\" or \"adds\")\n" +
                    "- Maximum 72 characters, no trailing period\n" +
                    "- Cover the single most significant change; ignore incidental churn\n" +
                    "- No quotation marks, backticks, or markdown formatting\n\n" +
                    "Reply with the message only — no preamble, explanation, or code fences.\n\n" +
                    "Staged diff:\n" +
                    diff.slice(0, 12000),
                },
              ],
              model: { providerID, modelID },
              ...(variant ? { variant } : {}),
            },
          }),
          120_000,
          "Commit message",
        );
        const parts: any[] = ((r.data as any)?.parts ?? []) as any[];
        const text = parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        if (text) {
          setMsg(text);
          return text;
        }
        setErr("Model returned no message.");
        return "";
      } finally {
        await dropSession(sid);
      }
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      return "";
    } finally {
      setGen(false);
    }
  };
  const genMsg = () => void genMessage();

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
  }, [refresh]);  useEffect(() => {
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

  // voice commands ("push", "commit", "stage all"…) — dispatched by
  // ChatPage's voice router; the ref keeps the latest closures reachable
  // without re-registering the listener on every render
  const gitCmdRef = useRef<(cmd: string) => void>(() => {});
  useEffect(() => {
    const h = (e: Event) => gitCmdRef.current((e as CustomEvent<string>).detail);
    window.addEventListener("oc:git", h);
    return () => window.removeEventListener("oc:git", h);
  }, []);

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

  gitCmdRef.current = (cmd: string) => {
    setOpen(true);
    if (cmd === "open") return;
    if (cmd === "push") {
      void doPush();
      return;
    }
    if (cmd === "pull") {
      void act(() => invoke("git_pull", { dir: dir.current }));
      return;
    }
    if (cmd === "stageAll") {
      void act(() => invoke("git_stage", { dir: dir.current, paths: changes.map((f) => f.path) }));
      return;
    }
    // commit — typed message wins; otherwise generate one and commit it
    if (busy || gen) return;
    if (!staged.length) {
      setErr("Nothing staged to commit.");
      return;
    }
    if (msg.trim()) void commit(false);
    else void genMessage().then((m) => { if (m) void commit(false, m); });
  };

  const toggleOpen = () => {
    setOpen((o) => {
      localStorage.setItem("oc.git.open", o ? "0" : "1");
      return !o;
    });
  };

  const row = (f: GitFile, isStaged: boolean) => {
    const raw = isStaged ? f.x : f.y;
    // porcelain marks untracked as "?" — show VS Code's "U" instead
    const letter = raw === "?" ? "U" : raw;
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
    <div className={`git-panel${dragging ? " dragging" : ""}`}>
      {open && (
        <div
          className="gp-resize"
          data-tip="Drag to resize · double-click to reset"
          onMouseDown={startResize}
          onDoubleClick={resetSize}
        />
      )}
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
        <div className="gp-body" style={{ height: gh }}>
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
                <button
                  className="gp-sect-toggle"
                  onClick={() => setStagedCollapsed((v) => !v)}
                  data-tip={stagedCollapsed ? "Expand staged" : "Collapse staged"}
                >
                  <i className={`fa-solid fa-chevron-${stagedCollapsed ? "right" : "down"} gp-sect-chev`} />
                  <span>Staged</span>
                  <span className="gp-sect-count">{staged.length}</span>
                </button>
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
              {!stagedCollapsed && staged.map((f) => row(f, true))}
            </>
          )}
          <div className="gp-sect">
            <button
              className="gp-sect-toggle"
              onClick={() => setChangesCollapsed((v) => !v)}
              data-tip={changesCollapsed ? "Expand changes" : "Collapse changes"}
            >
              <i className={`fa-solid fa-chevron-${changesCollapsed ? "right" : "down"} gp-sect-chev`} />
              <span>Changes</span>
              {!!changes.length && <span className="gp-sect-count">{changes.length}</span>}
            </button>
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
          {!changesCollapsed && (
            <>
              {changes.length === 0 && <div className="gp-empty">Working tree clean</div>}
              {changes.map((f) => row(f, false))}
            </>
          )}
        </div>
      )}

      {/* portal: the sidebar's backdrop-filter makes it the containing block
          for position:fixed — without this the dialog centers inside the
          sidebar instead of the window */}
      {diff &&
        createPortal(
          <Dialog
            title={`${base(diff.path)} — ${diff.staged ? "staged" : "working tree"} diff`}
            onClose={() => setDiff(null)}
            top
            wide
          >
            {diff.patch.trim() ? (
              <DiffLines patch={diff.patch} lang={extLang(diff.path)} />
            ) : (
              <p className="empty">No diff — new file or no unstaged edits.</p>
            )}
          </Dialog>,
          document.body,
        )}
    </div>
  );
}
