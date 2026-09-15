import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playSound } from "../lib/sounds";
import { splitModel } from "../lib/models";
import { pushToast } from "./useToast";
import { windowKey } from "../lib/windowScope";
import { getDirectory } from "../api";
import { getWorkspacePref, recordSelection } from "../lib/workspacePrefs";
import type { ProviderGroup } from "../types";

type OcClient = Awaited<ReturnType<typeof import("../api").opencode>>["client"];

// provider/model selection: boot-time loading + capability enrichment,
// per-window hand-picked model (windowKey("oc.lastModel") — each OS window
// keeps its own so two windows never steal each other's selection),
// server-default learning, per-session model memory
// (oc.sessionModels — explicit picks only), and thinking-effort variants
// (oc.variants global per-model + oc.sessionVariants per-session, like model/agent)
const SESSION_MODELS_KEY = "oc.sessionModels";
const LAST_MODEL_BASE = "oc.lastModel";
const SESSION_VARIANTS_KEY = "oc.sessionVariants";

function isReachable(model: string, groups: ProviderGroup[]): boolean {
  if (!model) return false;
  const [pid, mid] = splitModel(model);
  return groups.some((g) => g.id === pid && g.models.some((m) => m.id === mid));
}

// per-server groups, module-level so non-hook send sites (commit-gen,
// voice debrief, slash commands) can apply the same foreign-model guard
// without prop drilling. Written by loadProvidersAll, read-only otherwise.
const serverModelGroups = new Map<string, ProviderGroup[]>();
export function isModelOnServer(model: string, dir: string): boolean {
  if (!model) return true;
  const g = serverModelGroups.get(dir ?? "");
  if (!g) return true;
  return isReachable(model, g);
}

// fetch + record one server's groups unless already known. Fills the gap
// loadProvidersAll leaves when a tunnel wasn't up at boot (it skips dead
// servers silently) — without this the guard above fails open forever and
// the first send to that server dies the silent death. Failures stay
// fail-open; the send surfaces whatever happens.
export async function ensureServerGroups(
  getClient: (dir: string) => Promise<{ client: OcClient }>,
  dir: string,
): Promise<void> {
  const d = dir ?? "";
  if (serverModelGroups.has(d)) return;
  try {
    const { client } = await getClient(d);
    serverModelGroups.set(d, await fetchGroups(client));
  } catch {
    // still unreachable — fail open, the send surfaces whatever happens
  }
}

// fetch one server's provider groups (no state writes — merged by callers)
async function fetchGroups(client: OcClient): Promise<ProviderGroup[]> {
  const pr = await client.config.providers();
  const groups: ProviderGroup[] = ((pr.data?.providers ?? []) as any[]).map((prov) => ({
    id: prov.id,
    label: prov.name || prov.id,
    models: Object.entries(prov.models ?? {}).map(([mid, m]: [string, any]) => ({
      id: mid,
      label: m.name || mid,
      variants: Object.keys((m as any).variants ?? {}),
    })),
  }));
  try {
    const pl = await client.provider.list();
    const caps = new Map<string, { attachment: boolean; input: string[] }>();
    for (const prov of ((pl.data as any)?.all ?? []) as any[]) {
      for (const [mid, m] of Object.entries(prov.models ?? {})) {
        const cap = (m as any).capabilities ?? {};
        const kinds = Object.entries(cap.input ?? {})
          .filter(([, v]) => v === true)
          .map(([k]) => k);
        caps.set(`${prov.id}/${mid}`, {
          attachment: !!cap.attachment,
          input: kinds,
        });
      }
    }
    for (const g of groups)
      for (const m of g.models) {
        const c = caps.get(`${g.id}/${m.id}`);
        if (c) {
          m.attachment = c.attachment;
          m.input = c.input;
        }
      }
  } catch {
    // missing hints = UI stays fully enabled
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

// union provider groups across servers (local + SSH remotes may each have
// their own auth/models). Same provider id merges model lists by model id.
function mergeGroups(all: ProviderGroup[][]): ProviderGroup[] {
  const byId = new Map<string, ProviderGroup>();
  for (const groups of all) {
    for (const g of groups) {
      const cur = byId.get(g.id);
      if (!cur) {
        byId.set(g.id, { ...g, models: [...g.models] });
        continue;
      }
      const have = new Set(cur.models.map((m) => m.id));
      for (const m of g.models) {
        const at = cur.models.findIndex((x) => x.id === m.id);
        if (at < 0) {
          cur.models.push(m);
          have.add(m.id);
        } else {
          const u = new Set([...(cur.models[at].variants ?? []), ...(m.variants ?? [])]);
          cur.models[at] = { ...cur.models[at], variants: [...u] };
        }
      }
      if (!cur.label && g.label) cur.label = g.label;
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function useProviders(activeId: string) {
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  // per-window global model (primary: legacy key, secondaries: own namespace)
  const LAST_MODEL_KEY = windowKey(LAST_MODEL_BASE);
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [modelSel, setModelSel] = useState("");
  // per-session model memory: only entries that were EXPLICITLY picked for
  // that session get stored; everything else follows the global selection.
  // keyed by session id -> model. boot-load prunes models that vanished
  const [sessionModels, setSessionModels] = useState<Record<string, string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SESSION_MODELS_KEY) ?? "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  });
  // the server's effective fallback model is not exposed by any endpoint
  // (the /config/providers default map lies). It is *learned* from the first
  // reply of an unsteered prompt — see learnDefault / message.updated handling
  const [defaultModel, setDefaultModel] = useState("");
  // tracks whether the in-flight prompt carries an explicit model selection;
  // if not, the reply reveals the server's true default
  const sentExplicitModel = useRef(false);
  // thinking-effort variant per model ("provider/model" -> effort), remembered
  // across model switches, workspaces and relaunches ("" = model default).
  // Per-window namespaced like the model pick: secondaries seed a copy at
  // boot (workspacePrefs) then diverge independently.
  const VARIANTS_KEY = windowKey("oc.variants");
  const [variantMap, setVariantMap] = useState<Record<string, string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(VARIANTS_KEY) ?? "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  });
  // per-session thinking-effort memory (mirrors sessionModels/sessionAgents):
  // explicit picks are remembered per session id; that session's choice
  // outranks the global per-model map, so each session can keep its own
  // effort (low/high/default) independent of other sessions
  const [sessionVariants, setSessionVariants] = useState<Record<string, string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SESSION_VARIANTS_KEY) ?? "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  });
  const sessionModelsRef = useRef(sessionModels);
  useEffect(() => { sessionModelsRef.current = sessionModels; }, [sessionModels]);
  const sessionVariantsRef = useRef(sessionVariants);
  useEffect(() => { sessionVariantsRef.current = sessionVariants; }, [sessionVariants]);
  // B: pin only on user-initiated change — skip while restoring session
  const restoringRef = useRef(false);


  // per-window last hand-picked model — windowKey() namespaces it per OS
  // window (cross-window "storage" events can no longer leak a pick into a
  // window working in another project). only real selections persist — never
  // wipe the stored one with "". Every pick is also recorded into
  // per-workspace memory + shared last-used (workspacePrefs).
  useEffect(() => {
    if (modelSel) {
      try {
        localStorage.setItem(LAST_MODEL_KEY, modelSel);
      } catch {}
      // clear legacy per-window copy if it exists
      try {
        sessionStorage.removeItem(LAST_MODEL_KEY);
      } catch {}
      recordSelection({ model: modelSel });
    }
  }, [modelSel]);

  // live sync: same-window writers (picker + settings drawer share the key)
  // stay consistent; other OS windows use their own namespaced key and never
  // match here. sessions with a remembered model still outrank the global.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LAST_MODEL_KEY || !e.newValue) return;
      if (!providers.length) return;
      if (!isReachable(e.newValue, providers)) return;
      const remembered = sessionModels[activeId];
      if (remembered && isReachable(remembered, providers)) return;
      setModelSel((cur) => (cur === e.newValue! ? cur : e.newValue!));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [providers, activeId, sessionModels]);

  // persist the session->model map (every write is a validated selection)
  useEffect(() => {
    try {
      localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify(sessionModels));
    } catch {
      // quota exceeded or blocked — evict oldest and retry once, else toast
      try {
        const keys = Object.keys(sessionModels);
        if (keys.length > 1) {
          const trimmed = { ...sessionModels };
          delete trimmed[keys[0]];
          localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify(trimmed));
        } else {
          throw new Error("quota");
        }
      } catch {
        try { pushToast("Storage full — per-session model pins not saved"); } catch {}
      }
    }
  }, [sessionModels]);

  // persist the session->variant map
  useEffect(() => {
    try {
      localStorage.setItem(SESSION_VARIANTS_KEY, JSON.stringify(sessionVariants));
    } catch {}
  }, [sessionVariants]);



  const learnDefault = useCallback((resolved: string) => {
    setDefaultModel((prev) => (prev === resolved ? prev : resolved));
  }, []);

  const markExplicit = useCallback(() => {
    sentExplicitModel.current = !!modelSel;
  }, [modelSel]);

  // record (or clear) which model a session last used. written ONLY from
  // the picker path (user hand action); "" clears (that session follows the
  // instance global again). nothing automatic touches the map
  const rememberSession = useCallback((sid: string, value: string) => {
    if (!sid) return;
    setSessionModels((prev) => {
      if (!value) {
        if (!(sid in prev)) return prev;
        const next = { ...prev };
        delete next[sid];
        return next;
      }
      if (prev[sid] === value) return prev;
      return { ...prev, [sid]: value };
    });
  }, []);

  // merge one workspace-remembered effort into the per-model map (used by
  // the workspace-switch adapter and boot recovery below — setVariantSel
  // can't do it because it keys off the *current* modelSel, which may still
  // be the old model at apply time).
  const rememberModelVariant = useCallback(
    (model: string, value: string) => {
      if (!model) return;
      setVariantMap((prev) => {
        const next = { ...prev };
        if (value) next[model] = value;
        else delete next[model];
        try {
          localStorage.setItem(VARIANTS_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [VARIANTS_KEY],
  );

  // first-window boot recovery when no session is active yet (fresh project,
  // empty workspace view): apply the current workspace's last-used model +
  // effort once providers arrive. Skipped when the pending session has its
  // own pin — the restore effect below outranks workspace memory. Workspace
  // switches later go through the oc:workspaces-changed listener above.
  const wsBootDone = useRef(false);
  useEffect(() => {
    if (wsBootDone.current || !providers.length) return;
    wsBootDone.current = true;
    const sid = activeIdRef.current;
    const pin = sid ? sessionModelsRef.current[sid] : undefined;
    if (pin && isReachable(pin, providers)) return;
    const pref = getWorkspacePref(getDirectory());
    if (!pref.model || !isReachable(pref.model, providers)) return;
    const m = pref.model;
    restoringRef.current = true;
    try {
      localStorage.setItem(LAST_MODEL_KEY, m);
    } catch {}
    setModelSel((cur) => (cur === m ? cur : m));
    queueMicrotask(() => {
      restoringRef.current = false;
    });
    if (pref.variant !== undefined) rememberModelVariant(m, pref.variant);
  }, [providers, rememberModelVariant, LAST_MODEL_KEY]);

  // session switch (or providers arriving late): re-apply the active
  // session's remembered model when it exists and is still reachable;
  // otherwise the current workspace's last-used model; otherwise the
  // per-window global last model. The global is the
  // "last used model in this window" and is required on app launch
  // when the active session has no model. Unreachable remembered entries are
  // pruned so the session correctly follows the global from then on.
  useEffect(() => {
    if (!providers.length || !activeId) return;
    const remembered = sessionModels[activeId];
    if (remembered) {
      if (isReachable(remembered, providers)) {
        restoringRef.current = true;
        setModelSel((cur) => (cur === remembered ? cur : remembered));
        queueMicrotask(() => { restoringRef.current = false; });
        return;
      }
      // stale — provider/model vanished: drop the per-session pin
      setSessionModels((prev) => {
        if (!(activeId in prev)) return prev;
        const next = { ...prev };
        delete next[activeId];
        return next;
      });
    }
    // no valid per-session model — the workspace's last-used model wins over
    // the window global, so returning to a project restores its setup
    // (first-window boot recovery + secondary adapting to a known workspace).
    const wsModel = getWorkspacePref(getDirectory()).model;
    if (wsModel && isReachable(wsModel, providers)) {
      restoringRef.current = true;
      setModelSel((cur) => (cur === wsModel ? cur : wsModel));
      try {
        localStorage.setItem(LAST_MODEL_KEY, wsModel);
      } catch {}
      queueMicrotask(() => { restoringRef.current = false; });
      return;
    }
    // no valid per-session model — apply the shared global last model if
    // it exists and is still reachable (app-launch fallback + inter-session
    // fallback)
    let global: string | null = null;
    try {
      global = localStorage.getItem(LAST_MODEL_KEY) ?? sessionStorage.getItem(LAST_MODEL_KEY);
    } catch {}
    if (global && isReachable(global, providers)) {
      restoringRef.current = true;
      setModelSel((cur) => (cur === global ? cur : global));
      queueMicrotask(() => { restoringRef.current = false; });
    }
  }, [activeId, providers, sessionModels]);

  // generic watcher: any model change (dropdown, Tab, future shortcut) auto-pins per-session
  // B: skip while restoring and while still following global (unpinned)
  useEffect(() => {
    const sid = activeIdRef.current;
    if (!sid || restoringRef.current) return;
    if (!modelSel) {
      if (sessionModelsRef.current[sid]) rememberSession(sid, "");
      return;
    }
    if (!isReachable(modelSel, providers)) return;
    if (sessionModelsRef.current[sid] === modelSel) return;
    // unpinned sessions that are just showing the global last should not become pinned
    let global: string | null = null;
    try { global = localStorage.getItem(LAST_MODEL_KEY); } catch {}
    const hasPin = sid in sessionModelsRef.current;
    if (!hasPin && modelSel === global) return;
    rememberSession(sid, modelSel);
  }, [modelSel, providers]);

  // shared tail: publish groups, prune vanished per-session pins, restore last
  const applyGroups = useCallback((groups: ProviderGroup[]) => {
    setProviders(groups);

    // prune any per-session entries that vanished (provider/model removed)
    setSessionModels((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [sid, mod] of Object.entries(prev)) {
        if (!isReachable(mod, groups)) {
          delete next[sid];
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // restore the per-window last hand-picked model. Migrate a legacy
    // per-window sessionStorage entry if it exists — the app used to be
    // per-instance.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LAST_MODEL_KEY);
    } catch {}
    if (!saved) {
      try {
        const legacy = sessionStorage.getItem(LAST_MODEL_KEY);
        if (legacy) {
          try {
            localStorage.setItem(LAST_MODEL_KEY, legacy);
          } catch {}
          try {
            sessionStorage.removeItem(LAST_MODEL_KEY);
          } catch {}
          saved = legacy;
        }
      } catch {}
    }
    if (saved) {
      const [pid, mid] = splitModel(saved);
      if (groups.some((g) => g.id === pid && g.models.some((m) => m.id === mid))) {
        setModelSel((cur) => (cur === saved! ? cur : saved!));
      } else {
        try {
          localStorage.removeItem(LAST_MODEL_KEY);
        } catch {}
        try {
          sessionStorage.removeItem(LAST_MODEL_KEY);
        } catch {}
      }
    }
  }, []);

  // boot-time provider list + optional capability enrichment. attachment /
  // modality hints live only in GET /provider; SDK types stale AGAIN: runtime
  // nests under capabilities.{attachment,input} (input is a boolean map)
  const loadProviders = useCallback(
    async (client: OcClient) => {
      try {
        applyGroups(await fetchGroups(client));
      } catch (e) {
        // provider listing is optional, but show why it failed
        pushToast(`Failed to load models: ${e}`);
      }
    },
    [applyGroups],
  );

  // union across local + SSH servers (each may carry its own auth/models).
  // getClient resolves a workspace dir to its server client; failures per
  // server are skipped so one dead tunnel can't hide the local list.
  // Provenance is kept per dir: the merged picker can't tell which server
  // actually serves a model, and sending a foreign one dies SILENTLY
  // server-side (upstream prompt-loop bug: no session.error, just idle).
  const loadProvidersAll = useCallback(
    async (getClient: (dir: string) => Promise<{ client: OcClient }>, dirs: string[]) => {
      const all: ProviderGroup[][] = [];
      for (const d of ["", ...dirs]) {
        try {
          const { client } = await getClient(d);
          const groups = await fetchGroups(client);
          serverModelGroups.set(d, groups);
          all.push(groups);
        } catch {
          // dead tunnel / missing server — skip, toast comes from SSE layer
        }
      }
      if (all.length) applyGroups(mergeGroups(all));
    },
    [applyGroups],
  );

  // per-server reachability for a model id. Unknown dirs fail open (today's
  // behavior — server default or a visible request error, never new harm).
  const isModelOn = useCallback((model: string, dir: string): boolean => {
    return isModelOnServer(model, dir);
  }, []);

  // thinking-effort options for the selected model
  const modelVariants = useMemo(() => {
    if (!modelSel) return [];
    const [pid, mid] = splitModel(modelSel);
    return (
      providers.find((g) => g.id === pid)?.models.find((m) => m.id === mid)?.variants ?? []
    );
  }, [providers, modelSel]);

  // attachment capabilities of the selected model (undefined = allow all)
  const modelCaps = useMemo(() => {
    if (!modelSel) return undefined;
    const [pid, mid] = splitModel(modelSel);
    const m = providers.find((g) => g.id === pid)?.models.find((m) => m.id === mid);
    return m ? { attachment: m.attachment, input: m.input } : undefined;
  }, [providers, modelSel]);

  // current effort: per-session pin outranks the global per-model map,
  // so each session keeps its own thinking level and restores it on switch
  // (like model/agent). Empty or unreachable values fall back to default.
  // ponytail: single string per session, not per-model-per-session — if you
  // pick "high" for model A then switch to model B in the same session,
  // B sees "high" too when it has it; split to `${sid}:${model}` if that bites
  const variantSel = useMemo(() => {
    const sess = sessionVariants[activeId] ?? "";
    if (sess && (modelVariants.length === 0 || modelVariants.includes(sess))) return sess;
    const v = variantMap[modelSel] ?? "";
    return v && (modelVariants.length === 0 || modelVariants.includes(v)) ? v : "";
  }, [sessionVariants, activeId, variantMap, modelSel, modelVariants]);

  const setVariantSel = useCallback(
    (v: string, sid?: string) => {
      if (!modelSel) return;
      // global per-model last (for new chats)
      setVariantMap((prev) => {
        const next = { ...prev };
        if (v) next[modelSel] = v;
        else delete next[modelSel];
        try {
          localStorage.setItem(VARIANTS_KEY, JSON.stringify(next));
        } catch {
          // storage full/blocked — in-session map still works
        }
        return next;
      });
      recordSelection({ model: modelSel, variant: v });
      const target = sid ?? activeIdRef.current;
      if (!target) return;
      setSessionVariants((prev) => {
        if (!v) {
          if (!(target in prev)) return prev;
          const next = { ...prev };
          delete next[target];
          return next;
        }
        if (prev[target] === v) return prev;
        return { ...prev, [target]: v };
      });
    },
    [modelSel],
  );

  const forgetVariantSession = useCallback((sid: string) => {
    if (!sid) return;
    setSessionVariants((prev) => {
      if (!(sid in prev)) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
  }, []);

  const rememberVariantSession = useCallback((sid: string, value: string) => {
    if (!sid) return;
    setSessionVariants((prev) => {
      if (!value) {
        if (!(sid in prev)) return prev;
        const next = { ...prev };
        delete next[sid];
        return next;
      }
      if (prev[sid] === value) return prev;
      return { ...prev, [sid]: value };
    });
  }, []);

  // workspace switch → adapt the pickers to the newly-opened workspace's
  // last-used model + effort (when known and reachable on this window's
  // servers). Same-window custom event only — each window adapts
  // independently. Unreachable entries are skipped, never applied blind.
  useEffect(() => {
    const onWs = () => {
      if (!providers.length) return;
      const pref = getWorkspacePref(getDirectory());
      if (!pref.model || !isReachable(pref.model, providers)) return;
      const m = pref.model;
      restoringRef.current = true;
      try {
        localStorage.setItem(LAST_MODEL_KEY, m);
      } catch {}
      setModelSel((cur) => (cur === m ? cur : m));
      queueMicrotask(() => {
        restoringRef.current = false;
      });
      if (pref.variant !== undefined) rememberModelVariant(m, pref.variant);
    };
    window.addEventListener("oc:workspaces-changed", onWs);
    return () => window.removeEventListener("oc:workspaces-changed", onWs);
  }, [providers, rememberModelVariant, LAST_MODEL_KEY]);

  // chip click: effort cycles default -> low -> ... -> default
  const cycleVariant = useCallback(() => {
    if (!modelVariants.length) return;
    const opts = ["", ...modelVariants];
    setVariantSel(opts[(opts.indexOf(variantSel) + 1) % opts.length]);
    playSound("click");
  }, [modelVariants, variantSel, setVariantSel]);

  // watcher for variant (covers Tab/future shortcuts) — B: skip restoring and global fallback
  useEffect(() => {
    const sid = activeIdRef.current;
    if (!sid || restoringRef.current || !modelSel) return;
    const cur = variantSel;
    if (sessionVariantsRef.current[sid] === cur) return;
    const hasPin = sid in sessionVariantsRef.current;
    const globalForModel = variantMap[modelSel] ?? "";
    if (!hasPin && cur === globalForModel) return;
    rememberVariantSession(sid, cur);
  }, [variantSel, modelSel]);

  return {
    providers,
    modelSel,
    setModelSel,
    rememberSession,
    forgetVariantSession,
    rememberVariantSession,
    defaultModel,
    learnDefault,
    sentExplicitModel,
    markExplicit,
    loadProviders,
    loadProvidersAll,
    isModelOn,
    modelVariants,
    modelCaps,
    variantSel,
    setVariantSel,
    cycleVariant,
    sessionModels,
    sessionVariants,
  };
}

