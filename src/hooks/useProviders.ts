import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playSound } from "../lib/sounds";
import { splitModel } from "../lib/models";
import type { ProviderGroup } from "../types";

type OcClient = Awaited<ReturnType<typeof import("../api").opencode>>["client"];

// provider/model selection: boot-time loading + capability enrichment,
// persisted hand-picked model (oc.lastModel), server-default learning,
// and per-model thinking-effort variants (oc.variants)
export function useProviders(onError: (msg: string) => void) {
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [modelSel, setModelSel] = useState("");
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

  // remember the last hand-picked model across launches
  // (only persist real selections — never wipe the stored one with "")
  useEffect(() => {
    if (modelSel) localStorage.setItem("oc.lastModel", modelSel);
  }, [modelSel]);

  const learnDefault = useCallback((resolved: string) => {
    setDefaultModel((prev) => (prev === resolved ? prev : resolved));
  }, []);

  const markExplicit = useCallback(() => {
    sentExplicitModel.current = !!modelSel;
  }, [modelSel]);

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

        // restore the last hand-picked model if it still exists
        const saved = localStorage.getItem("oc.lastModel");
        if (saved) {
          const [pid, mid] = splitModel(saved);
          if (groups.some((g) => g.id === pid && g.models.some((m) => m.id === mid))) {
            setModelSel(saved);
          } else {
            localStorage.removeItem("oc.lastModel");
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

  // current model's stored effort — kept if the option still exists, else
  // default. never reset on switch: each model remembers its own
  // ponytail: pass-through while providers are still loading (empty list);
  // a pick for a model that later drops all variants rides along until then
  const variantSel = useMemo(() => {
    const v = variantMap[modelSel] ?? "";
    return v && (modelVariants.length === 0 || modelVariants.includes(v)) ? v : "";
  }, [variantMap, modelSel, modelVariants]);

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
    },
    [modelSel],
  );

  // chip click: effort cycles default -> low -> ... -> default
  const cycleVariant = useCallback(() => {
    if (!modelVariants.length) return;
    const opts = ["", ...modelVariants];
    setVariantSel(opts[(opts.indexOf(variantSel) + 1) % opts.length]);
    playSound("click");
  }, [modelVariants, variantSel, setVariantSel]);

  return {
    providers,
    modelSel,
    setModelSel,
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
  };
}

