import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, opencode, tempSession, dropSession } from "../api";
import { splitModel } from "../lib/models";
import { extLang } from "../lib/syntax";
import { playSound } from "../lib/sounds";
import { heuristicCommit } from "../lib/commitHeuristic";
import { buildCommitPrompt, cleanCommitMessage } from "../lib/commitPrompt";
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

// secondary model + commitBody from the settings blob — read at click time
function secondaryModel(): string {
  try {
    const v = JSON.parse(localStorage.getItem("oc.settings") ?? "{}").secondaryModel;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}
function commitBodyEnabled(): boolean {
  try {
    return !!JSON.parse(localStorage.getItem("oc.settings") ?? "{}").commitBody;
  } catch {
    return false;
  }
}
function cachedVariant(sel: string): string | undefined {
  try {
    const m = JSON.parse(localStorage.getItem("oc.variants") ?? "{}");
    const v = m?.[sel];
    if (typeof v === "string" && v) return v;
  } catch {}
  return undefined;
}
async function variantFast(client: any, providerID: string, modelID: string, fallback?: string): Promise<string | undefined> {
  if (fallback) return fallback;
  // quick probe with deadline 700ms — don't block prompt on it
  try {
    const pr: any = await Promise.race([
      client.config.providers(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("variant timeout")), 700)),
    ]);
    const prov = (pr.data?.providers ?? []).find((p: any) => p.id === providerID);
    const vars = Object.keys(prov?.models?.[modelID]?.variants ?? {});
    if (vars.includes("low")) return "low";
    if (vars.includes("minimal")) return "minimal";
    if (vars.includes("fast")) return "fast";
  } catch {}
  return undefined;
}

// staged = index column meaningful; changes = worktree column or untracked
const stagedOf = (files: GitFile[]) => files.filter((f) => f.x !== " " && f.x !== "?");
const changedOf = (files: GitFile[]) => files.filter((f) => f.y !== " ");

  // keep body toggle reactive without prop drilling — poll localStorage
function useCommitBody(): boolean {
  const [v, setV] = useState(() => commitBodyEnabled());
  useEffect(() => {
    const sync = () => setV(commitBodyEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    const id = window.setInterval(sync, 1000);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
      window.clearInterval(id);
    };
  }, []);
  return v;
}

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
  const bodyOpt = useCommitBody();
  const genIdRef = useRef(0);
  const genSidRef = useRef<string | null>(null);
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

  const abortGen = useCallback(() => {
    if (!gen) return;
    genIdRef.current++;
    const sid = genSidRef.current;
    genSidRef.current = null;
    setGen(false);
    if (sid) {
      opencode().then(({ client }) => client.session.abort({ path: { id: sid } }).catch(() => {})).catch(() => {});
      dropSession(sid).catch(() => {});
    }
  }, [gen]);

  const commit = (thenPush = false, override?: string) =>
    act(async () => {
      // heuristic commit: stop the still-streaming AI so it can't overwrite the cleared input
      if (gen) abortGen();
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

  // AI commit message: instant heuristic fill + streaming AI upgrade.
  // Heuristic shows in <50ms; AI via promptAsync poll fills the textarea
  // progressively (target 5s). Voice "commit" chains it straight into git_commit.
  const genMessage = async (): Promise<string> => {
    if (gen || busy || !staged.length) return "";
    const model = secondaryModel();
    const includeBody = commitBodyEnabled();
    const myId = ++genIdRef.current;
    setGen(true);
    setErr("");
    // capture staged snapshot for this run
    const stagedSnap = [...staged];
    const branchSnap = st.branch;
    let heuristicFallback = heuristicCommit({ staged: stagedSnap, branch: branchSnap });
    try {
      // parallel: diff + stat + log (stat/log are cheap, diff may be large)
      const [diffRaw, statRaw, logRaw] = await Promise.all([
        invoke<string>("git_diff", { dir: dir.current, path: "", staged: true }).catch(() => ""),
        invoke<string>("git_diff_stat", { dir: dir.current }).catch(() => ""),
        invoke<string>("git_log", { dir: dir.current }).catch(() => ""),
      ]);
      if (!diffRaw.trim() && !statRaw.trim()) {
        setErr("Staged diff is empty.");
        return "";
      }
      // heuristic fills instantly — user sees a message immediately
      const heuristic = heuristicCommit({ staged: stagedSnap, stat: statRaw, diff: diffRaw.slice(0, 4000), branch: branchSnap });
      heuristicFallback = heuristic;
      setMsg(heuristic);

      if (!model) {
        // no AI configured — heuristic is the result (quality local fallback)
        return heuristic;
      }

      const { client } = await opencode();
      const [providerID, modelID] = splitModel(model);
      const cached = cachedVariant(model);
      // don't block on providers probe — race 700ms
      const variant = await variantFast(client, providerID, modelID, cached);

      const promptText = buildCommitPrompt({
        staged: stagedSnap.map((f) => ({ path: f.path, x: f.x })),
        branch: branchSnap,
        stat: statRaw,
        diff: diffRaw,
        log: logRaw,
        includeBody,
      });

      const sid = await tempSession();
      genSidRef.current = sid;
      let best = heuristic;
      let streamed = "";
      try {
        await client.session.promptAsync({
          path: { id: sid },
          body: {
            parts: [{ type: "text", text: promptText }],
            model: { providerID, modelID },
            ...(variant ? { variant } : {}),
          },
        } as any);

        // poll session messages for progressive fill (perceived streaming)
        const start = Date.now();
        const deadline = 60000; // hard cap; 4× previous (15s→60s) for quality
        while (Date.now() - start < deadline) {
          if (genIdRef.current !== myId) break; // aborted by commit
          await new Promise((r) => setTimeout(r, 260));
          if (genIdRef.current !== myId) break;
          try {
            const r: any = await client.session.messages({ path: { id: sid } });
            const list: any[] = (r.data ?? []) as any[];
            const assistants = list.filter((m: any) => m.info?.role === "assistant");
            const last = assistants[assistants.length - 1];
            if (!last) continue;
            const parts: any[] = (last.parts ?? []) as any[];
            const raw = parts.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("").trim();
            if (!raw) continue;
            const cleaned = cleanCommitMessage(raw, includeBody);
            if (cleaned && cleaned !== streamed) {
              if (genIdRef.current !== myId) break;
              streamed = cleaned;
              best = cleaned;
              setMsg(cleaned); // progressively fills the textarea
            }
            if (last.info?.time?.completed) break;
            // early exit if we already have a good subject within 5s
            if (streamed && Date.now() - start > 5000 && last.info?.time?.completed) break;
          } catch {
            // transient fetch error — keep polling
          }
        }

        if (genIdRef.current !== myId) return heuristicFallback; // commit won, don't overwrite
        if (!streamed) {
          // no AI delta arrived — keep heuristic, surface hint
          setErr("AI slow — using heuristic. Edit or retry.");
          return heuristic;
        }
        return best;
      } finally {
        if (genSidRef.current === sid) genSidRef.current = null;
        await dropSession(sid);
      }
    } catch (e) {
      if (genIdRef.current !== myId) return heuristicFallback;
      const m = String(e).replace(/^Error:\s*/, "");
      setErr(m);
      // keep heuristic in box so voice commit can proceed
      return heuristicFallback;
    } finally {
      if (genIdRef.current === myId) setGen(false);
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
            <textarea
              className="gp-msg"
              placeholder={
                bodyOpt
                  ? `Message + body (${staged.length} staged) — Ctrl+Enter to commit`
                  : `Message (${staged.length} staged)`
              }
              value={msg}
              rows={bodyOpt || msg.includes("\n") ? 3 : 1}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  if (bodyOpt) {
                    if ((e.ctrlKey || e.metaKey) && canCommit) {
                      e.preventDefault();
                      commit(false);
                    }
                  } else if (canCommit) {
                    e.preventDefault();
                    commit(false);
                  }
                }
              }}
              disabled={busy}
            />
            <button
              className={`gp-gen${gen ? " spinning" : ""}`}
              data-tip={
                secondaryModel()
                  ? `Generate message (${secondaryModel()})${bodyOpt ? " + body" : ""}`
                  : "Heuristic only — pick a Secondary model for AI"
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
              <div
                className="gp-sect"
                role="button"
                tabIndex={0}
                onClick={() => setStagedCollapsed((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setStagedCollapsed((v) => !v);
                  }
                }}
                data-tip={stagedCollapsed ? "Expand staged" : "Collapse staged"}
              >
                <span className="gp-sect-toggle">
                  <i className={`fa-solid fa-chevron-${stagedCollapsed ? "right" : "down"} gp-sect-chev`} />
                  <span>Staged</span>
                  <span className="gp-sect-count">{staged.length}</span>
                </span>
                <button
                  className="gp-sact"
                  data-tip="Unstage all"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void act(() => invoke("git_unstage", { dir: dir.current, paths: staged.map((f) => f.path) }));
                  }}
                >
                  <i className="fa-solid fa-minus" />
                  Unstage all
                </button>
              </div>
              {!stagedCollapsed && staged.map((f) => row(f, true))}
            </>
          )}
          <div
            className="gp-sect"
            role="button"
            tabIndex={0}
            onClick={() => setChangesCollapsed((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setChangesCollapsed((v) => !v);
              }
            }}
            data-tip={changesCollapsed ? "Expand changes" : "Collapse changes"}
          >
            <span className="gp-sect-toggle">
              <i className={`fa-solid fa-chevron-${changesCollapsed ? "right" : "down"} gp-sect-chev`} />
              <span>Changes</span>
              {!!changes.length && <span className="gp-sect-count">{changes.length}</span>}
            </span>
            <span className="gp-sect-acts">
              {!!changes.length && (
                <>
                  <button
                    className="gp-sact"
                    data-tip="Stage all"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(() => invoke("git_stage", { dir: dir.current, paths: changes.map((f) => f.path) }));
                    }}
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
                          onClick={(e) => {
                            e.stopPropagation();
                            void discardAll();
                          }}
                        >
                          <i className="fa-solid fa-check" />
                          Sure?
                        </button>
                        <button
                          className="gp-sact"
                          data-tip="Keep"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmPath("");
                          }}
                        >
                          <i className="fa-solid fa-xmark" />
                        </button>
                      </>
                    ) : (
                      <button
                        className="gp-sact"
                        data-tip="Discard all unstaged"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmPath("*");
                        }}
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
