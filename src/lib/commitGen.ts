// AI commit-message generation — moved verbatim from GitPanel.tsx: diff
// fetch → heuristic fill → temp session → 60s polling loop → drop session.
// Pure logic, no UI: the panel passes a deps object (client accessor, dir,
// settings getters, announce callbacks) plus the two refs sharing the
// abort-button protocol (genId token bumps on abort; genSid holds the temp
// session id the abort button kills). commitHeuristic/commitPrompt already
// live here — imported, not duplicated.

import { invoke } from "@tauri-apps/api/core";
import { tempSession, dropSession } from "../api";
import { isModelOnServer } from "../hooks/useProviders";
import { splitModel } from "./models";
import { heuristicCommit } from "./commitHeuristic";
import { buildCommitPrompt, cleanCommitMessage } from "./commitPrompt";

export type GenFile = { path: string; x: string; y: string };

export type CommitGenDeps = {
  all: boolean; // commit-all scope — also fetches the unstaged diff
  dir: string;
  files: GenFile[]; // source snapshot (staged or allDirty)
  branch: string;
  client: () => Promise<{ client: any }>; // opencodeFor(dir)
  secondaryModel: () => string;
  commitBody: () => boolean;
  cachedVariant: (sel: string) => string | undefined;
  genIdRef: { current: number };
  genSidRef: { current: string | null };
  onMessage: (m: string) => void; // heuristic + streamed fill (setMsg)
  onError: (e: string) => void; // error strip (setErr)
  setGenerating: (on: boolean) => void; // spinner (setGen)
};

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

export async function generateCommitMessage(deps: CommitGenDeps): Promise<string> {
  const dir = deps.dir;
  const stagedSnap = [...deps.files];
  const branchSnap = deps.branch;
  const model = deps.secondaryModel();
  const includeBody = deps.commitBody();
  const myId = ++deps.genIdRef.current;
  deps.setGenerating(true);
  deps.onError("");
  let heuristicFallback = heuristicCommit({ staged: stagedSnap, branch: branchSnap });
  try {
    const diffPromises: Promise<string>[] = [];
    if (deps.all) {
      diffPromises.push(
        invoke<string>("git_diff", { dir, path: "", staged: true }).catch(() => ""),
        invoke<string>("git_diff", { dir, path: "", staged: false }).catch(() => ""),
      );
    } else {
      diffPromises.push(invoke<string>("git_diff", { dir, path: "", staged: true }).catch(() => ""));
    }
    const diffRaws = await Promise.all(diffPromises);
    const diffRaw = diffRaws.join("\n");
    const [statRaw, logRaw] = await Promise.all([
      invoke<string>("git_diff_stat", { dir }).catch(() => ""),
      invoke<string>("git_log", { dir }).catch(() => ""),
    ]);
    if (!diffRaw.trim() && !statRaw.trim()) {
      deps.onError("Diff is empty.");
      return "";
    }
    const heuristic = heuristicCommit({ staged: stagedSnap, stat: statRaw, diff: diffRaw.slice(0, 4000), branch: branchSnap });
    heuristicFallback = heuristic;
    deps.onMessage(heuristic);
    if (!model) return heuristic;
    // a foreign model dies silently server-side (no session.error, just
    // idle) — fall back to the heuristic with a visible note instead
    if (!isModelOnServer(model, dir)) {
      deps.onError(`Model ${model} isn't on this server — heuristic used.`);
      return heuristic;
    }
    const { client } = await deps.client();
    const [providerID, modelID] = splitModel(model);
    const cached = deps.cachedVariant(model);
    const variant = await variantFast(client, providerID, modelID, cached);
    const promptText = buildCommitPrompt({
      staged: stagedSnap.map((f) => ({ path: f.path, x: f.x })),
      branch: branchSnap,
      stat: statRaw,
      diff: diffRaw,
      log: logRaw,
      includeBody,
    });
    const sid = await tempSession(dir);
    deps.genSidRef.current = sid;
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
        if (deps.genIdRef.current !== myId) break;
        await new Promise((r) => setTimeout(r, 260));
        if (deps.genIdRef.current !== myId) break;
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
            if (deps.genIdRef.current !== myId) break;
            streamed = cleaned;
            best = cleaned;
            deps.onMessage(cleaned);
          }
          if (last.info?.time?.completed) break;
          if (streamed && Date.now() - start > 5000 && last.info?.time?.completed) break;
        } catch {}
      }
      if (deps.genIdRef.current !== myId) return heuristicFallback;
      if (!streamed) {
        deps.onError("AI slow — using heuristic. Edit or retry.");
        return heuristic;
      }
      return best;
    } finally {
      if (deps.genSidRef.current === sid) deps.genSidRef.current = null;
      await dropSession(sid, dir);
    }
  } catch (e) {
    if (deps.genIdRef.current !== myId) return heuristicFallback;
    const m = String(e).replace(/^Error:\s*/, "");
    deps.onError(m);
    return heuristicFallback;
  } finally {
    if (deps.genIdRef.current === myId) deps.setGenerating(false);
  }
}
