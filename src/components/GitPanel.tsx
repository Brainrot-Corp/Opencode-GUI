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
import DropdownPortal from "./DropdownPortal";
import "../styles/git.css";

const GH_KEY = "oc.git.h";
const GH_MIN = 120;
const GH_DEFAULT = 220;
const PRIMARY_KEY = "oc.git.primary";
const AMEND_KEY = "oc.git.amend";
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

const base = (p: string) => p.replace(/\/$/, "").slice(p.replace(/\/$/, "").lastIndexOf("/") + 1);

// primary commit actions — persisted as the split-button's current action
type PrimaryAction =
  | "staged"
  | "all"
  | "stagedPush"
  | "allPush"
  | "stagedSync"
  | "allSync";
function loadPrimary(): PrimaryAction {
  const v = localStorage.getItem(PRIMARY_KEY);
  if (v === "all" || v === "stagedPush" || v === "allPush" || v === "stagedSync" || v === "allSync") return v as PrimaryAction;
  return "staged";
}

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
const isTracked = (f: GitFile) => !(f.x === "?" && f.y === "?");
const isUntracked = (f: GitFile) => f.x === "?" && f.y === "?";
const allTrackedDirtyOf = (files: GitFile[]) => files.filter((f) => isTracked(f) && (f.x !== " " || f.y !== " "));

function dedupFiles(files: GitFile[]): GitFile[] {
  const m = new Map<string, GitFile>();
  for (const f of files) m.set(f.path, f);
  return [...m.values()];
}

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
  const [confirmPath, setConfirmPath] = useState("");
  const [gen, setGen] = useState(false);
  const [diff, setDiff] = useState<{ path: string; patch: string; staged: boolean } | null>(null);
  const bodyOpt = useCommitBody();
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const genIdRef = useRef(0);
  const genSidRef = useRef<string | null>(null);
  const [genHover, setGenHover] = useState(false);
  const dir = useRef(getDirectory());
  const autosizeMsg = useCallback(() => {
    const el = msgRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(() => { autosizeMsg(); }, [msg, bodyOpt, open, autosizeMsg]);
  const [gh, setGh] = useState(() => clampH(Number(localStorage.getItem(GH_KEY)) || GH_DEFAULT));
  const [dragging, setDragging] = useState(false);
  useEffect(() => { localStorage.setItem(GH_KEY, String(gh)); }, [gh]);
  const [stagedCollapsed, setStagedCollapsed] = useState(() => localStorage.getItem("oc.git.stagedCollapsed") === "1");
  const [changesCollapsed, setChangesCollapsed] = useState(() => localStorage.getItem("oc.git.changesCollapsed") === "1");
  useEffect(() => { localStorage.setItem("oc.git.stagedCollapsed", stagedCollapsed ? "1" : "0"); }, [stagedCollapsed]);
  useEffect(() => { localStorage.setItem("oc.git.changesCollapsed", changesCollapsed ? "1" : "0"); }, [changesCollapsed]);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [amend, setAmend] = useState(() => localStorage.getItem(AMEND_KEY) === "1");
  const [primary, setPrimary] = useState<PrimaryAction>(() => loadPrimary());
  const commitAnchorRef = useRef<HTMLDivElement>(null);
  const moreAnchorRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { localStorage.setItem(AMEND_KEY, amend ? "1" : "0"); }, [amend]);
  useEffect(() => { localStorage.setItem(PRIMARY_KEY, primary); }, [primary]);
  useEffect(() => {
    if (!commitMenuOpen && !moreMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".gp-menu") || t.closest(".gp-split") || t.closest(".gp-more-wrap")) return;
      setCommitMenuOpen(false);
      setMoreMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setCommitMenuOpen(false); setMoreMenuOpen(false); }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [commitMenuOpen, moreMenuOpen]);
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

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return false;
      setBusy(true);
      setErr("");
      let ok = true;
      try {
        await fn();
      } catch (e) {
        const raw = String(e).replace(/^Error:\s*/, "");
        if (/has no upstream branch|no upstream branch|set upstream/i.test(raw)) {
          setErr(raw + "\nTip: Push with --set-upstream or set remote via git push -u origin " + (st.branch || "<branch>"));
        } else if (/nothing to commit|no changes added to commit/i.test(raw) && !amend) {
          setErr(raw + " — try Commit All (includes tracked changes) or Stage first.");
        } else {
          setErr(raw);
        }
        ok = false;
      }
      await refresh();
      setBusy(false);
      return ok;
    },
    [busy, refresh, st.branch, amend],
  );

  const abortGen = useCallback(() => {
    if (!gen) return;
    genIdRef.current++;
    const sid = genSidRef.current;
    genSidRef.current = null;
    setGen(false);
    setGenHover(false);
    if (sid) {
      opencode().then(({ client }) => client.session.abort({ path: { id: sid } }).catch(() => {})).catch(() => {});
      dropSession(sid).catch(() => {});
    }
  }, [gen]);

  useEffect(() => {
    if (!gen) setGenHover(false);
  }, [gen]);

  // derived file sets — keep before commit/gen helpers so deps exist
  const staged = stagedOf(st.files);
  const changes = changedOf(st.files);
  const allTrackedDirty = allTrackedDirtyOf(st.files);
  const canCommitStaged = !!msg.trim() && staged.length > 0 && !busy;
  const canCommitAll = !!msg.trim() && allTrackedDirty.length > 0 && !busy;

  // unified commit helper covering VS variants: staged vs all (-a), amend, push, sync
  const genMessage = async (opts?: { all?: boolean }): Promise<string> => {
    const useAll = !!opts?.all;
    const allDirty = allTrackedDirtyOf(st.files);
    const srcFiles = useAll ? dedupFiles(allDirty) : [...staged];
    const genFiles = srcFiles;
    if (gen || busy || !genFiles.length) {
      if (!genFiles.length) setErr(useAll ? "Nothing to commit (tracked)." : "Nothing staged to generate from.");
      return "";
    }
    const model = secondaryModel();
    const includeBody = commitBodyEnabled();
    const myId = ++genIdRef.current;
    setGen(true);
    setErr("");
    const stagedSnap = [...genFiles];
    const branchSnap = st.branch;
    let heuristicFallback = heuristicCommit({ staged: stagedSnap, branch: branchSnap });
    try {
      const diffPromises: Promise<string>[] = [];
      if (useAll) {
        diffPromises.push(
          invoke<string>("git_diff", { dir: dir.current, path: "", staged: true }).catch(() => ""),
          invoke<string>("git_diff", { dir: dir.current, path: "", staged: false }).catch(() => ""),
        );
      } else {
        diffPromises.push(invoke<string>("git_diff", { dir: dir.current, path: "", staged: true }).catch(() => ""));
      }
      const diffRaws = await Promise.all(diffPromises);
      const diffRaw = diffRaws.join("\n");
      const [statRaw, logRaw] = await Promise.all([
        invoke<string>("git_diff_stat", { dir: dir.current }).catch(() => ""),
        invoke<string>("git_log", { dir: dir.current }).catch(() => ""),
      ]);
      if (!diffRaw.trim() && !statRaw.trim()) {
        setErr("Diff is empty.");
        return "";
      }
      const heuristic = heuristicCommit({ staged: stagedSnap, stat: statRaw, diff: diffRaw.slice(0, 4000), branch: branchSnap });
      heuristicFallback = heuristic;
      setMsg(heuristic);
      if (!model) return heuristic;
      const { client } = await opencode();
      const [providerID, modelID] = splitModel(model);
      const cached = cachedVariant(model);
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
        const start = Date.now();
        const deadline = 60000;
        while (Date.now() - start < deadline) {
          if (genIdRef.current !== myId) break;
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
              setMsg(cleaned);
            }
            if (last.info?.time?.completed) break;
            if (streamed && Date.now() - start > 5000 && last.info?.time?.completed) break;
          } catch {}
        }
        if (genIdRef.current !== myId) return heuristicFallback;
        if (!streamed) {
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
      return heuristicFallback;
    } finally {
      if (genIdRef.current === myId) setGen(false);
    }
  };
  const genMsg = (useAll?: boolean) => void genMessage({ all: !!useAll });

  const doCommit = useCallback(async (opts: { all?: boolean; push?: boolean; sync?: boolean; override?: string }) => {
    const useAll = !!opts.all;
    const usePush = !!opts.push;
    const useSync = !!opts.sync;
    let message = (opts.override ?? msg).trim();
    if (!message) {
      const m = await genMessage({ all: useAll });
      if (!m) return false;
      message = m;
    }
    if (!message) {
      setErr("Enter a commit message or generate one.");
      return false;
    }
    const hasStaged = staged.length > 0;
    const hasAll = allTrackedDirty.length > 0;
    if (!amend) {
      if (useAll && !hasAll) { setErr("Nothing to commit — working tree clean (tracked files)."); return false; }
      if (!useAll && !hasStaged) { setErr("Nothing staged to commit — Stage files or use Commit All."); return false; }
    }
    if (gen) abortGen();
    const ok = await act(async () => {
      await invoke("git_commit", { dir: dir.current, message, amend, all: useAll });
      if (useAll) {
        setSt((s) => ({
          ...s,
          files: s.files.filter((f) => isUntracked(f)),
        }));
      } else {
        setSt((s) => ({
          ...s,
          files: s.files.filter((f) => f.x === " " || f.x === "?"),
        }));
      }
      setMsg("");
      if (useSync) {
        await invoke("git_pull", { dir: dir.current });
        await invoke("git_push", { dir: dir.current });
      } else if (usePush) {
        await invoke("git_push", { dir: dir.current });
      }
    });
    return ok;
  }, [msg, staged, allTrackedDirty, amend, gen, act, abortGen]);

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
  const doFetch = async () => {
    await act(() => invoke("git_fetch", { dir: dir.current }));
    setMoreMenuOpen(false);
  };
  const doSync = async () => {
    await act(async () => {
      await invoke("git_pull", { dir: dir.current });
      await invoke("git_push", { dir: dir.current });
    });
    setMoreMenuOpen(false);
  };

  const rowAct = (cmd: string, path: string) => {
    setConfirmPath("");
    return act(() => invoke(cmd, { dir: dir.current, paths: [path] }));
  };

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

  const primaryLabelMap: Record<PrimaryAction, string> = {
    staged: "Commit Staged",
    all: "Commit All",
    stagedPush: "Commit Staged + Push",
    allPush: "Commit All + Push",
    stagedSync: "Commit Staged + Sync",
    allSync: "Commit All + Sync",
  };
  const primaryHintMap: Record<PrimaryAction, string> = {
    staged: "Commit staged changes",
    all: "Commit all tracked changes (-a, skip untracked)",
    stagedPush: "Commit staged and push",
    allPush: "Commit all tracked and push",
    stagedSync: "Commit staged and sync (pull then push)",
    allSync: "Commit all tracked and sync",
  };
  const runPrimary = () => {
    switch (primary) {
      case "staged": void doCommit({ all: false }); break;
      case "all": void doCommit({ all: true }); break;
      case "stagedPush": void doCommit({ all: false, push: true }); break;
      case "allPush": void doCommit({ all: true, push: true }); break;
      case "stagedSync": void doCommit({ all: false, sync: true }); break;
      case "allSync": void doCommit({ all: true, sync: true }); break;
    }
  };
  const hint = (() => {
    if (busy || gen) return "";
    if (!msg.trim() && staged.length > 0) return "Tip: generate a message or type one.";
    if (!msg.trim() && allTrackedDirty.length > 0 && staged.length === 0) return "No staged changes — use Commit All or Stage All.";
    if (!staged.length && allTrackedDirty.length > 0) return "No staged changes. Commit All will commit tracked changes (−a, skips untracked).";
    if (!allTrackedDirty.length && !staged.length && st.files.length === 0) return "";
    if (!allTrackedDirty.length) return "";
    return "";
  })();

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
    if (busy || gen) return;
    if (!staged.length && !allTrackedDirty.length) {
      setErr("Nothing to commit.");
      return;
    }
    const useAll = !staged.length && allTrackedDirty.length > 0;
    if (msg.trim()) void doCommit({ all: useAll });
    else void genMessage({ all: useAll }).then((m) => { if (m) void doCommit({ all: useAll, override: m }); });
  };

  const toggleOpen = () => {
    setOpen((o) => {
      localStorage.setItem("oc.git.open", o ? "0" : "1");
      return !o;
    });
  };

  const row = (f: GitFile, isStaged: boolean) => {
    const raw = isStaged ? f.x : f.y;
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

  const commitMenu = (
    <div className="gp-menu">
      <label className="gp-menu-check">
        <input type="checkbox" checked={amend} onChange={(e) => { setAmend(e.target.checked); playSound("click"); }} />
        <span>Amend previous commit</span>
      </label>
      <div className="gp-menu-sep" />
      <button className="gp-menu-item" disabled={busy} onClick={() => { setPrimary("staged"); setCommitMenuOpen(false); setErr(""); void doCommit({ all: false }); }}>
        <i className="fa-solid fa-check" /> Commit Staged
        {!staged.length && !amend && <span className="gp-menu-hint">no staged</span>}
      </button>
      <button className="gp-menu-item" disabled={busy} onClick={() => { setPrimary("all"); setCommitMenuOpen(false); void doCommit({ all: true }); }}>
        <i className="fa-solid fa-layer-group" /> Commit All
        <span className="gp-menu-hint">−a, skip untracked</span>
      </button>
      <div className="gp-menu-sep" />
      <button className="gp-menu-item" disabled={busy} onClick={() => { setPrimary("stagedPush"); setCommitMenuOpen(false); void doCommit({ all: false, push: true }); }}>
        <i className="fa-solid fa-check-double" /> Commit Staged and Push
      </button>
      <button className="gp-menu-item" disabled={busy} onClick={() => { setPrimary("allPush"); setCommitMenuOpen(false); void doCommit({ all: true, push: true }); }}>
        <i className="fa-solid fa-cloud-arrow-up" /> Commit All and Push
      </button>
      <button className="gp-menu-item" disabled={busy} onClick={() => { setPrimary("stagedSync"); setCommitMenuOpen(false); void doCommit({ all: false, sync: true }); }}>
        <i className="fa-solid fa-rotate" /> Commit Staged and Sync
      </button>
      <button className="gp-menu-item" disabled={busy} onClick={() => { setPrimary("allSync"); setCommitMenuOpen(false); void doCommit({ all: true, sync: true }); }}>
        <i className="fa-solid fa-arrows-rotate" /> Commit All and Sync
      </button>
      {hint && <div className="gp-menu-hintline">{hint}</div>}
    </div>
  );

  const moreMenu = (
    <div className="gp-menu">
      <button className="gp-menu-item" disabled={busy} onClick={doFetch}>
        <i className="fa-solid fa-cloud-arrow-down" /> Fetch
      </button>
      <button className="gp-menu-item" disabled={busy} onClick={doSync}>
        <i className="fa-solid fa-rotate" /> Sync <span className="gp-menu-hint">Pull then Push</span>
      </button>
      <div className="gp-menu-sep" />
      <button className="gp-menu-item" disabled={busy} onClick={() => { setMoreMenuOpen(false); void act(() => invoke("git_stage", { dir: dir.current, paths: changes.filter(isTracked).map(f=>f.path) })); }}>
        <i className="fa-solid fa-plus" /> Stage all tracked
      </button>
      <button className="gp-menu-item" disabled={busy || !allTrackedDirty.length} onClick={() => { setMoreMenuOpen(false); void genMessage({ all: true }); }}>
        <i className="fa-solid fa-wand-magic-sparkles" /> Generate message (All)
      </button>
    </div>
  );

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
              ref={msgRef}
              className="gp-msg"
              placeholder={
                bodyOpt
                  ? `Message + body (${staged.length} staged, ${allTrackedDirty.length} tracked) — Ctrl+Enter to commit`
                  : `Message (${staged.length} staged / ${allTrackedDirty.length} tracked)`
              }
              value={msg}
              rows={1}
              onChange={(e) => setMsg(e.target.value)}
              onInput={autosizeMsg}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  if (bodyOpt) {
                    if ((e.ctrlKey || e.metaKey)) {
                      const can = primary.includes("all") ? canCommitAll || amend : canCommitStaged || amend;
                      if (can || msg.trim()) { e.preventDefault(); runPrimary(); }
                    }
                  } else {
                    const can = primary.includes("all") ? canCommitAll || amend : canCommitStaged || amend;
                    if (can || msg.trim()) { e.preventDefault(); runPrimary(); }
                  }
                }
              }}
              disabled={busy}
            />
            <button
              className={`gp-gen${gen ? " spinning" : ""}${gen && genHover ? " abort" : ""}`}
              data-tip={
                gen
                  ? "Stop generation"
                  : secondaryModel()
                    ? `Generate message (${secondaryModel()})${bodyOpt ? " + body" : ""} — for ${primary.includes("all") ? "All (−a)" : "Staged"}`
                    : "Heuristic only — pick a Secondary model for AI"
              }
              disabled={busy || (!gen && !(primary.includes("all") ? allTrackedDirty.length : staged.length))}
              onMouseEnter={() => gen && setGenHover(true)}
              onMouseLeave={() => setGenHover(false)}
              onClick={() => {
                if (gen) {
                  abortGen();
                } else {
                  genMsg(primary.includes("all"));
                }
              }}
            >
              <i className={`fa-solid ${gen && genHover ? "fa-xmark" : "fa-wand-magic-sparkles"}`} />
            </button>
          </div>
          <div className="gp-actions">
            <div className="gp-split" ref={commitAnchorRef}>
              <button
                className="gp-commit-main"
                data-tip={primaryHintMap[primary] + (amend ? " — amend" : "")}
                disabled={busy || (!amend && (primary.includes("all") ? !allTrackedDirty.length : !staged.length))}
                onClick={runPrimary}
              >
                <i className={`fa-solid ${primary.includes("Push") ? "fa-cloud-arrow-up" : primary.includes("Sync") ? "fa-rotate" : "fa-check"}`} />
                {primaryLabelMap[primary]}{amend ? " (Amend)" : ""}
              </button>
              <button
                className="gp-commit-drop"
                data-tip="More commit actions"
                aria-expanded={commitMenuOpen}
                onClick={() => { setCommitMenuOpen(o=>!o); setMoreMenuOpen(false); playSound("click"); }}
              >
                <i className={`fa-solid fa-chevron-${commitMenuOpen ? "up" : "down"}`} />
              </button>
            </div>
            <button
              className={`push${pushed === "ok" ? " pushed" : ""}`}
              data-tip="Push to remote"
              disabled={busy || pushed === "run" || (!st.ahead && !staged.length && !allTrackedDirty.length)}
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
            <button ref={moreAnchorRef as any} className="gp-more" data-tip="More actions (Fetch, Sync)" aria-expanded={moreMenuOpen} onClick={()=>{ setMoreMenuOpen(o=>!o); setCommitMenuOpen(false); playSound("click"); }}>
              <i className="fa-solid fa-ellipsis" />
            </button>
          </div>
          <DropdownPortal anchor={commitAnchorRef} open={commitMenuOpen} prefer="up" align="left">
            {commitMenu}
          </DropdownPortal>
          <DropdownPortal anchor={moreAnchorRef} open={moreMenuOpen} prefer="up" align="right">
            {moreMenu}
          </DropdownPortal>
          {err && <div className="gp-err mono">{err}</div>}
          {!err && hint && <div className="gp-hint mono">{hint}</div>}
          {amend && <div className="gp-hint mono">Amend mode — next commit amends the previous commit.</div>}

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
                    data-tip="Stage all (includes untracked)"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(() => invoke("git_stage", { dir: dir.current, paths: changes.map((f) => f.path) }));
                    }}
                  >
                    <i className="fa-solid fa-plus" />
                    Stage all
                  </button>
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
