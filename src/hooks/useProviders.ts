import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playSound } from "../lib/sounds";
import { splitModel } from "../lib/models";
import type { ProviderGroup } from "../types";

type OcClient = Awaited<ReturnType<typeof import("../api").opencode>>["client"];

// provider/model selection: boot-time loading + capability enrichment,
// shared hand-picked model (localStorage oc.lastModel — synced across all
// windows), server-default learning, per-session model memory
// (oc.sessionModels — explicit picks only), and thinking-effort variants
// (oc.variants global per-model + oc.sessionVariants per-session, like model/agent)
const SESSION_MODELS_KEY = "oc.sessionModels";
const LAST_MODEL_KEY = "oc.lastModel";
const SESSION_VARIANTS_KEY = "oc.sessionVariants";
const DISABLED_VARIANTS_KEY = "oc.disabledVariants";

function isReachable(model: string, groups: ProviderGroup[]): boolean {
  if (!model) return false;
  const [pid, mid] = splitModel(model);
  return groups.some((g) => g.id === pid && g.models.some((m) => m.id === mid));
}

export function useProviders(onError: (msg: string) => void, activeId: string) {
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
  // across model switches, workspaces and relaunches ("" = model default)
  const [variantMap, setVariantMap] = useState<Record<string, string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("oc.variants") ?? "{}");
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
  // ponytail: global disabled set for thinking-effort cycle (frontend override like agents)
  const [disabledVariants, setDisabledVariants] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DISABLED_VARIANTS_KEY) ?? "[]");
      return new Set(Array.isArray(raw) ? raw.filter((x: unknown) => typeof x === "string") : []);
    } catch { return new Set<string>(); }
  });

  // shared last hand-picked model — visible to every window/instance via
  // localStorage (cross-window "storage" events keep live windows in sync).
  // only real selections persist — never wipe the stored one with ""
  useEffect(() => {
    if (modelSel) {
      try {
        localStorage.setItem(LAST_MODEL_KEY, modelSel);
      } catch {}
      // clear legacy per-window copy if it exists
      try {
        sessionStorage.removeItem(LAST_MODEL_KEY);
      } catch {}
    }
  }, [modelSel]);

  // live sync: another window picked a model -> reflect it here unless the
  // active session has its own remembered model (which outranks the global)
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
    localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify(sessionModels));
  }, [sessionModels]);

  // persist the session->variant map
  useEffect(() => {
    try {
      localStorage.setItem(SESSION_VARIANTS_KEY, JSON.stringify(sessionVariants));
    } catch {}
  }, [sessionVariants]);

  useEffect(() => {
    try { localStorage.setItem(DISABLED_VARIANTS_KEY, JSON.stringify([...disabledVariants])); } catch {}
  }, [disabledVariants]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DISABLED_VARIANTS_KEY) return;
      try {
        const arr = JSON.parse(e.newValue ?? "[]");
        setDisabledVariants(new Set(Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === "string") : []));
      } catch {}
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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

  // session switch (or providers arriving late): re-apply the active
  // session's remembered model when it exists and is still reachable;
  // otherwise fall back to the shared global last model. The global is the
  // "last used model between all instances" and is required on app launch
  // when the active session has no model. Unreachable remembered entries are
  // pruned so the session correctly follows the global from then on.
  useEffect(() => {
    if (!providers.length || !activeId) return;
    const remembered = sessionModels[activeId];
    if (remembered) {
      if (isReachable(remembered, providers)) {
        setModelSel((cur) => (cur === remembered ? cur : remembered));
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
    // no valid per-session model — apply the shared global last model if
    // it exists and is still reachable (app-launch fallback + inter-session
    // fallback)
    let global: string | null = null;
    try {
      global = localStorage.getItem(LAST_MODEL_KEY) ?? sessionStorage.getItem(LAST_MODEL_KEY);
    } catch {}
    if (global && isReachable(global, providers)) {
      setModelSel((cur) => (cur === global ? cur : global));
    }
  }, [activeId, providers, sessionModels]);

  // boot-time provider list + optional capability enrichment. attachment /
  // modality hints live only in GET /provider; SDK types stale AGAIN: runtime
  // nests under capabilities.{attachment,input} (input is a boolean map)
  const loadProviders = useCallback(
    async (client: OcClient) => {
      try {
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

        // restore the *shared* last hand-picked model (localStorage so every
        // window/instance sees the same value). Migrate a legacy per-window
        // sessionStorage entry if it exists — the app used to be per-instance.
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
      } catch (e) {
        // provider listing is optional, but show why it failed
        onError(`Failed to load models: ${e}`);
      }
    },
    [onError],
  );

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
    (v: string) => {
      if (!modelSel) return;
      setVariantMap((prev) => {
        const next = { ...prev };
        if (v) next[modelSel] = v;
        else delete next[modelSel];
        try {
          localStorage.setItem("oc.variants", JSON.stringify(next));
        } catch {
          // storage full/blocked — in-session map still works
        }
        return next;
      });
      if (!activeId) return;
      setSessionVariants((prev) => {
        if (!v) {
          if (!(activeId in prev)) return prev;
          const next = { ...prev };
          delete next[activeId];
          return next;
        }
        if (prev[activeId] === v) return prev;
        return { ...prev, [activeId]: v };
      });
    },
    [modelSel, activeId],
  );

  const toggleDisabledVariant = useCallback((name: string) => {
    setDisabledVariants((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      playSound("click");
      return next;
    });
  }, []);

  // chip click: effort cycles default -> low -> ... -> default (skips disabled)
  const cycleVariant = useCallback(() => {
    if (!modelVariants.length) return;
    const opts = ["", ...modelVariants];
    const enabled = opts.filter((o) => !disabledVariants.has(o));
    if (!enabled.length) return;
    let idx = opts.indexOf(variantSel);
    if (idx < 0) idx = 0;
    for (let step = 1; step <= opts.length; step++) {
      const cand = opts[(idx + step) % opts.length];
      if (!disabledVariants.has(cand)) {
        setVariantSel(cand);
        playSound("click");
        return;
      }
    }
  }, [modelVariants, variantSel, disabledVariants, setVariantSel]);

  return {
    providers,
    modelSel,
    setModelSel,
    rememberSession,
    defaultModel,
    learnDefault,
    sentExplicitModel,
    markExplicit,
    loadProviders,
    modelVariants,
    modelCaps,
    variantSel,
    setVariantSel,
    cycleVariant,
    disabledVariants,
    toggleDisabledVariant,
  };
}

