import { useCallback, useEffect, useRef, useState, Component, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDirectory, opencode, tempSession, dropSession } from "../api";
import { splitModel } from "../lib/models";
import { extLang } from "../lib/syntax";
import { playSound } from "../lib/sounds";
import { heuristicCommit } from "../lib/commitHeuristic";
import { buildCommitPrompt, cleanCommitMessage } from "../lib/commitPrompt";
import Dialog from "./Dialog";
import { DiffLines } from "./DiffPanel";
import DropdownPortal from "./DropdownPortal";
import { useTranslation } from "../lib/i18n";
import "../styles/git.css";

const GH_KEY = "oc.git.h";
const GH_MIN = 120;
const GH_DEFAULT = 220;
const PRIMARY_KEY = "oc.git.primary";
const AMEND_KEY = "oc.git.amend";
const clampH = (h: number) =>
  Math.min(Math.max(GH_MIN, Math.floor(h)), Math.floor(window.innerHeight * 0.6));

type GitFile = { path: string; orig_path?: string | null; x: string; y: string; staged?: boolean; conflict?: boolean };
type GitStatus = {
  repo: boolean;
  root?: string;
  branch: string;
  detached?: boolean;
  upstream?: string | null;
  gone?: boolean;
  ahead: number;
  behind: number;
  files: GitFile[];
  initial?: boolean;
  in_merge?: boolean;
  in_rebase?: boolean;
  stash_count?: number;
};

const CLEAN: GitStatus = { repo: false, branch: "", ahead: 0, behind: 0, files: [] };

const base = (p: string) => p.replace(/\/$/, "").slice(p.replace(/\/$/, "").lastIndexOf("/") + 1);
const dirOf = (p: string) => {
  const t = p.replace(/\/$/, "");
  const i = t.lastIndexOf("/");
  return i > 0 ? t.slice(0, i) : "";
};

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

// staged/conflict come from the backend (VSCode parity); fall back to XY
// derivation for stale payloads. Untracked (??) is add, never conflict.
const isConflict = (f: GitFile) =>
  f.conflict ?? (f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D"));
const isStaged = (f: GitFile) =>
  f.staged ?? (!isConflict(f) && f.x !== " " && f.x !== "?");
const stagedOf = (files: GitFile[]) => files.filter(isStaged);
const conflictsOf = (files: GitFile[]) => files.filter(isConflict);
const changedOf = (files: GitFile[]) => files.filter((f) => !isConflict(f) && f.y !== " ");
const isTracked = (f: GitFile) => !(f.x === "?" && f.y === "?");
const isUntracked = (f: GitFile) => f.x === "?" && f.y === "?";

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

function GitPanelInner() {
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
  const { t } = useTranslation();
  const curDir = () => getDirectory();
  const watchRootRef = useRef("");
  const refreshTimer = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  const queuedRef = useRef(false);
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
  const [stashBusy, setStashBusy] = useState(false);
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

  // single-flight: overlapping spawns (watcher burst + poll + file-saves,
  // two mounted instances) coalesce instead of piling up git processes.
  const refresh = useCallback(async () => {
    if (refreshingRef.current) {
      queuedRef.current = true;
      return;
    }
    refreshingRef.current = true;
    try {
      const s = await invoke<GitStatus>("git_status", { dir: curDir() });
      setSt(s);
      if (s.repo && s.root && s.root !== watchRootRef.current) {
        watchRootRef.current = s.root;
        invoke("git_watch", { dir: curDir() }).catch(() => {});
      }
    } catch {
      setSt(CLEAN);
    } finally {
      refreshingRef.current = false;
    }
    if (queuedRef.current) {
      queuedRef.current = false;
      void refresh();
    }
  }, []);

  // trailing debounce for event-driven refreshes (file saves, watcher push,
  // workspace/storage noise) — own ops and focus still refresh immediately.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 800);
  }, [refresh]);

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
          setErr(raw + " — try Commit All (includes all changes) or Stage first.");
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
  const conflicts = conflictsOf(st.files);
  const noUpstream = st.repo && !st.detached && !(st.upstream ?? "");
  // Commit All scope: staged + unstaged, tracked + untracked (A), minus
  // conflicts. Snapshot at click so files appearing mid-commit aren't swept in.
  const allDirty = dedupFiles([...staged, ...changes]);
  const canCommitStaged = !!msg.trim() && staged.length > 0 && !busy;
  const canCommitAll = !!msg.trim() && allDirty.length > 0 && !busy;

  // unified commit helper covering VS variants: staged vs all (stage snapshot then commit), amend, push, sync
  const genMessage = async (opts?: { all?: boolean }): Promise<string> => {
    const useAll = !!opts?.all;
    const srcFiles = useAll ? [...allDirty] : [...staged];
    const genFiles = srcFiles;
    if (gen || busy || !genFiles.length) {
      if (!genFiles.length) setErr(useAll ? "Nothing to commit." : "Nothing staged to generate from.");
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
          invoke<string>("git_diff", { dir: curDir(), path: "", staged: true }).catch(() => ""),
          invoke<string>("git_diff", { dir: curDir(), path: "", staged: false }).catch(() => ""),
        );
      } else {
        diffPromises.push(invoke<string>("git_diff", { dir: curDir(), path: "", staged: true }).catch(() => ""));
      }
      const diffRaws = await Promise.all(diffPromises);
      const diffRaw = diffRaws.join("\n");
      const [statRaw, logRaw] = await Promise.all([
        invoke<string>("git_diff_stat", { dir: curDir() }).catch(() => ""),
        invoke<string>("git_log", { dir: curDir() }).catch(() => ""),
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
    // snapshot click-time file set so changes appearing mid-commit (AI gen,
    // push/sync round-trips) are NOT swept into this commit
    const snapPaths = useAll ? allDirty.map((f) => f.path) : [];
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
    const hasAll = allDirty.length > 0;
    if (!amend) {
      if (useAll && !hasAll) { setErr("Nothing to commit — working tree clean."); return false; }
      if (!useAll && !hasStaged) { setErr("Nothing staged to commit — Stage files or use Commit All."); return false; }
    }
    if (gen) abortGen();
    const ok = await act(async () => {
      if (useAll && snapPaths.length) {
        // stage only what isn't already staged — git fatals the whole batch
        // on a pathspec matching nothing (e.g. an already-staged deletion),
        // and the commit reads the index anyway
        const needStage = [
          ...new Set(snapPaths.filter((p) => allDirty.some((f) => f.path === p && f.y !== " "))),
        ];
        if (needStage.length) {
          await invoke("git_stage", { dir: curDir(), paths: needStage });
        }
        await invoke("git_commit", { dir: curDir(), message, amend, all: false });
      } else {
        await invoke("git_commit", { dir: curDir(), message, amend, all: useAll });
      }
      if (useAll) {
        const snap = new Set(snapPaths);
        setSt((s) => ({
          ...s,
          files: s.files.filter((f) => !snap.has(f.path)),
        }));
      } else {
        setSt((s) => ({
          ...s,
          files: s.files.filter((f) => !isStaged(f)),
        }));
      }
      setMsg("");
      if (useSync) {
        await invoke("git_sync", { dir: curDir() });
      } else if (usePush) {
        await invoke("git_push", { dir: curDir(), upstream: noUpstream ? true : undefined });
      }
    });
    return ok;
  }, [msg, staged, allDirty, amend, gen, act, abortGen, noUpstream]);

  const [pushed, setPushed] = useState<"idle" | "run" | "ok">("idle");
  const doPush = async () => {
    if (pushed !== "idle") return;
    setPushed("run");
    const ok = await act(() => invoke("git_push", { dir: curDir(), upstream: noUpstream ? true : undefined }));
    setPushed(ok ? "ok" : "idle");
  };
  useEffect(() => {
    if (pushed !== "ok") return;
    const t = setTimeout(() => setPushed("idle"), 1800);
    return () => clearTimeout(t);
  }, [pushed]);
  const doFetch = async () => {
    await act(() => invoke("git_fetch", { dir: curDir(), prune: true }));
    setMoreMenuOpen(false);
  };
  const doSync = async () => {
    await act(() => invoke("git_sync", { dir: curDir() }));
    setMoreMenuOpen(false);
  };

  const rowAct = (cmd: string, path: string) => {
    setConfirmPath("");
    return act(() => invoke(cmd, { dir: curDir(), paths: [path] }));
  };

  // VSCode parity: discard covers untracked too (backend splits restore/clean).
  // Single-file discard goes through the row confirm; bulk discard-all keeps
  // its own "*" confirm in the Changes header.
  const discardAll = () => {
    const paths = [...changes, ...staged.filter((f) => isUntracked(f))].map((f) => f.path);
    return act(() =>
      invoke("git_discard", { dir: curDir(), paths: [...new Set(paths)] }),
    ).then(() => setConfirmPath(""));
  };

  const openDiff = async (f: GitFile, isStaged: boolean) => {
    const patch = await invoke<string>("git_diff", {
      dir: curDir(),
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
    // watcher push (Rust `.git` notify → `git://changed`) + file-saves +
    // workspace switches refresh debounced; 4s poll stays as fallback.
    let tauriUnlisten: (() => void) | undefined;
    listen<string>("git://changed", () => scheduleRefresh())
      .then((off) => { tauriUnlisten = off; })
      .catch(() => {});
    const t = setInterval(refresh, 4000);
    const onVis = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("focus", onVis);
    window.addEventListener("oc:file-changed", scheduleRefresh);
    window.addEventListener("oc:workspaces-changed", scheduleRefresh);
    window.addEventListener("oc:last-workspace-changed", scheduleRefresh);
    window.addEventListener("storage", scheduleRefresh);
    return () => {
      clearInterval(t);
      if (refreshTimer.current) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      window.removeEventListener("focus", onVis);
      window.removeEventListener("oc:file-changed", scheduleRefresh);
      window.removeEventListener("oc:workspaces-changed", scheduleRefresh);
      window.removeEventListener("oc:last-workspace-changed", scheduleRefresh);
      window.removeEventListener("storage", scheduleRefresh);
      tauriUnlisten?.();
    };
  }, [open, st.repo, refresh, scheduleRefresh]);

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
          <span>{t("git.noRepo")}</span>
        </div>
      </div>
    );

  const primaryLabelMap: Record<PrimaryAction, string> = {
    staged: t("git.commit.staged"),
    all: t("git.commit.all"),
    stagedPush: t("git.commit.stagedPush"),
    allPush: t("git.commit.allPush"),
    stagedSync: t("git.commit.stagedSync"),
    allSync: t("git.commit.allSync"),
  };
  const primaryHintMap: Record<PrimaryAction, string> = {
    staged: "Commit staged changes",
    all: "Commit all changes (staged + unstaged, incl. untracked)",
    stagedPush: "Commit staged and push",
    allPush: "Commit all changes and push",
    stagedSync: "Commit staged and sync (pull then push)",
    allSync: "Commit all changes and sync",
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
    if (!msg.trim() && allDirty.length > 0 && staged.length === 0) return "No staged changes — use Commit All or Stage All.";
    if (!staged.length && allDirty.length > 0) return "No staged changes. Commit All will commit all changes (incl. untracked).";
    if (!allDirty.length && !staged.length && st.files.length === 0) return "";
    if (!allDirty.length) return "";
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
      void act(() => invoke("git_pull", { dir: curDir() }));
      return;
    }
    if (cmd === "stageAll") {
      void act(() => invoke("git_stage", { dir: curDir(), paths: changes.map((f) => f.path) }));
      return;
    }
    if (busy || gen) return;
    if (!staged.length && !allDirty.length) {
      setErr("Nothing to commit.");
      return;
    }
    const useAll = !staged.length && allDirty.length > 0;
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
    const untracked = isUntracked(f);
    // untracked shows green A (was purple U — same glyph as conflicts);
    // conflicts never reach here (own section) but stay purple if they do.
    const raw = isStaged ? f.x : f.y;
    const letter = untracked ? "A" : isConflict(f) ? "U" : raw === "?" ? "A" : raw;
    const confirming = confirmPath === f.path;
    const d = dirOf(f.path);
    return (
      <div key={f.path + (isStaged ? "~s" : "~w")} className={`gp-row${confirming ? " confirming" : ""}`}>
        <span className={`gp-x ${xcls(letter)} mono`}>{letter}</span>
        <button
          className="gp-file mono"
          data-tip={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}
          onClick={() => !untracked && openDiff(f, isStaged)}
          disabled={untracked}
        >
          {d ? <span className="gp-dir">{d}/</span> : null}{base(f.path)}
        </button>
        <span className="gp-acts">
          {confirming ? (
            <>
              <button className="gp-act danger" data-tip={untracked ? "Really delete file" : "Really discard"} onClick={() => rowAct("git_discard", f.path)}>
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
              {!isStaged && (
                <button
                  className="gp-act"
                  data-tip={untracked ? "Delete file" : "Discard changes"}
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

  const conflictRow = (f: GitFile) => {
    const confirming = confirmPath === f.path;
    const d = dirOf(f.path);
    return (
      <div key={f.path + "~c"} className={`gp-row${confirming ? " confirming" : ""}`}>
        <span className="gp-x conf mono">U</span>
        <button className="gp-file mono" data-tip={f.path} onClick={() => openDiff(f, false)}>
          {d ? <span className="gp-dir">{d}/</span> : null}{base(f.path)}
        </button>
        <span className="gp-acts">
          <button className="gp-act" data-tip="Accept ours" onClick={() => rowAct2("git_resolve", f.path, true)}>
            <i className="fa-solid fa-arrow-left" />
          </button>
          <button className="gp-act" data-tip="Accept theirs" onClick={() => rowAct2("git_resolve", f.path, false)}>
            <i className="fa-solid fa-arrow-right" />
          </button>
        </span>
      </div>
    );
  };

  const rowAct2 = (cmd: string, path: string, ours: boolean) => {
    setConfirmPath("");
    return act(() => invoke(cmd, { dir: curDir(), path, ours }));
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
        <span className="gp-menu-hint">incl. untracked</span>
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
    </div>
  );

  const doStash = async (includeUntracked: boolean) => {
    setMoreMenuOpen(false);
    setStashBusy(true);
    try {
      await invoke("git_stash_push", { dir: curDir(), message: msg.trim() || null, include_untracked: includeUntracked });
      setMsg("");
      await refresh();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setStashBusy(false);
    }
  };
  const moreMenu = (
    <div className="gp-menu">
      <button className="gp-menu-item" disabled={busy} onClick={doFetch}>
        <i className="fa-solid fa-cloud-arrow-down" /> Fetch <span className="gp-menu-hint">prune</span>
      </button>
      <button className="gp-menu-item" disabled={busy} onClick={doSync}>
        <i className="fa-solid fa-rotate" /> Sync <span className="gp-menu-hint">Pull --rebase then Push</span>
      </button>
      {noUpstream && (
        <button className="gp-menu-item" disabled={busy} onClick={() => { setMoreMenuOpen(false); void act(() => invoke("git_publish", { dir: curDir() })); }}>
          <i className="fa-solid fa-cloud-arrow-up" /> Publish branch <span className="gp-menu-hint">push -u origin</span>
        </button>
      )}
      <button className="gp-menu-item" disabled={busy} onClick={() => {
        setMoreMenuOpen(false);
        if (confirmPath === "force-push") {
          setConfirmPath("");
          void act(() => invoke("git_push", { dir: curDir(), force_lease: true }));
        } else setConfirmPath("force-push");
      }}>
        <i className="fa-solid fa-triangle-exclamation" /> {confirmPath === "force-push" ? "Confirm force-with-lease?" : "Force push (with lease)"}
      </button>
      <div className="gp-menu-sep" />
      <button className="gp-menu-item" disabled={busy} onClick={() => { setMoreMenuOpen(false); void act(() => invoke("git_stage", { dir: curDir(), paths: changes.filter(isTracked).map(f=>f.path) })); }}>
        <i className="fa-solid fa-plus" /> Stage all tracked
      </button>
      <button className="gp-menu-item" disabled={busy || !allDirty.length} onClick={() => { setMoreMenuOpen(false); void genMessage({ all: true }); }}>
        <i className="fa-solid fa-wand-magic-sparkles" /> Generate message (All)
      </button>
      <div className="gp-menu-sep" />
      <button className="gp-menu-item" disabled={busy || stashBusy} onClick={() => void doStash(false)}>
        <i className="fa-solid fa-box-archive" /> Stash changes
      </button>
      <button className="gp-menu-item" disabled={busy || stashBusy} onClick={() => void doStash(true)}>
        <i className="fa-solid fa-boxes-stacked" /> Stash incl. untracked
      </button>
      <button className="gp-menu-item" disabled={busy || !(st.stash_count ?? 0)} onClick={() => { setMoreMenuOpen(false); void act(() => invoke("git_stash_pop", { dir: curDir() })); }}>
        <i className="fa-solid fa-box-open" /> Stash pop {(st.stash_count ?? 0) > 0 && <span className="gp-menu-hint">{st.stash_count}</span>}
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
        <span className="gp-right">
          {!!conflicts.length && <span className="gp-badge gp-badge-conf">{conflicts.length}!</span>}
          {!!st.files.length && <span className="gp-badge">{st.files.length}</span>}
          {(st.stash_count ?? 0) > 0 && <span className="gp-badge" data-tip={`${st.stash_count} stashes`}>≡{st.stash_count}</span>}
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
          <span className="mono gp-branch-name" data-tip={st.detached ? "Detached HEAD" : st.upstream ? `tracking ${st.upstream}${st.gone ? " (gone)" : ""}` : "No upstream — use Publish"}>
            {st.detached ? `HEAD ${st.branch}` : st.branch}{st.gone ? "?" : noUpstream ? " ↑" : ""}
          </span>
        </span>
      </button>

      {open && (
        <div className="gp-body" style={{ height: gh }}>
          <div className="gp-msgrow">
            <textarea
              ref={msgRef}
              className="gp-msg"
              placeholder={
                bodyOpt
                  ? `Message + body (${staged.length} staged, ${allDirty.length} changed) — Ctrl+Enter to commit`
                  : `Message (${staged.length} staged / ${allDirty.length} changed)`
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
                    ? `Generate message (${secondaryModel()})${bodyOpt ? " + body" : ""} — for ${primary.includes("all") ? "All" : "Staged"}`
                    : "Heuristic only — pick a Secondary model for AI"
              }
              disabled={busy || (!gen && !(primary.includes("all") ? allDirty.length : staged.length))}
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
                disabled={busy || (!amend && (primary.includes("all") ? !allDirty.length : !staged.length))}
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
              data-tip={noUpstream ? "Publish branch (push -u origin)" : "Push to remote"}
              disabled={busy || pushed === "run" || (!st.ahead && !staged.length && !allDirty.length && !noUpstream)}
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
              {pushed === "ok" ? "Pushed" : noUpstream ? "Publish" : "Push"}
            </button>
            <button data-tip="Pull" disabled={busy} onClick={() => act(() => invoke("git_pull", { dir: curDir() }))}>
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
          {st.detached && <div className="gp-hint mono">Detached HEAD at {st.branch} — checkout a branch to commit.</div>}
          {st.initial && <div className="gp-hint mono">No commits yet — first commit creates the branch.</div>}
          {noUpstream && !st.detached && <div className="gp-hint mono">No upstream — Push publishes (-u origin {st.branch}).</div>}
          {st.gone && <div className="gp-hint mono">Upstream is gone — publish again or reset.</div>}
          {(st.in_merge || st.in_rebase) && (
            <div className="gp-hint mono">
              {st.in_merge ? "Merging — resolve conflicts then commit." : "Rebasing — resolve then continue."}{" "}
              <button className="gp-sact" disabled={busy} onClick={() => act(() => invoke(st.in_merge ? "git_merge_abort" : "git_rebase_abort", { dir: curDir() }))}>Abort</button>
              {" "}
              <button className="gp-sact" disabled={busy} onClick={() => act(() => invoke(st.in_merge ? "git_merge_continue" : "git_rebase_continue", { dir: curDir() }))}>Continue</button>
            </div>
          )}

          {conflicts.length > 0 && (
            <>
              <div className="gp-sect" data-tip="Unmerged paths — pick ours/theirs per file">
                <span className="gp-sect-toggle">
                  <span>Conflicts</span>
                  <span className="gp-sect-count">{conflicts.length}</span>
                </span>
              </div>
              {conflicts.map(conflictRow)}
            </>
          )}

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
                    void act(() => invoke("git_unstage", { dir: curDir(), paths: staged.map((f) => f.path) }));
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
                      void act(() => invoke("git_stage", { dir: curDir(), paths: changes.map((f) => f.path) }));
                    }}
                  >
                    <i className="fa-solid fa-plus" />
                    Stage all
                  </button>
                  {changes.length > 0 &&
                    (confirmPath === "*" ? (
                      <>
                        <button
                          className="gp-sact danger"
                          data-tip="Really discard all (deletes untracked)"
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
                        data-tip="Discard all changes (deletes untracked)"
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

// Error boundary: a render throw used to blank the whole app (React unmounts
// the root). Show the message in-panel with a retry instead.
class GitBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    console.error("[git-panel]", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="git-panel">
          <div className="gp-err mono">
            Git panel crashed: {String((this.state.error as any)?.message ?? this.state.error)}
          </div>
          <button className="gp-sact" onClick={() => this.setState({ error: null })}>
            <i className="fa-solid fa-rotate-right" /> Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function GitPanel() {
  return (
    <GitBoundary>
      <GitPanelInner />
    </GitBoundary>
  );
}
