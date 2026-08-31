// Remote "recommended setup" spec for the onboarding wizard — fetched from a
// plain JSON file on GitHub so recommendations update without shipping a
// build. Every download source can be overridden by full URL; anything absent
// falls back to the built-in constants in kokoro.ts.
//
// ponytail: ids-only validation against known shapes, not live catalog
// membership — a bad id fails at download time with the normal error row.
import { invoke } from "@tauri-apps/api/core";

// paste your raw.githubusercontent.com URL here, e.g.
// "https://raw.githubusercontent.com/<user>/<repo>/main/recommended.json"
export const RECO_URL =
  "https://raw.githubusercontent.com/NoxLoveYa/-Vibecoded-Agent/refs/heads/main/recommended/recommended.json";

export const DEFAULT_RECO: Reco = {
  version: 1,
  whisperModel: "ggml-base.bin",
  ttsVoice: "en_US-amy-medium",
};

export type Reco = {
  version: number;
  // whisper ggml filename ("ggml-base.bin") / piper voice id without extension
  whisperModel: string;
  ttsVoice: string;
  // optional human line shown under the wizard's setup button
  note?: string;
  // suggested secondary model ("provider/model") — applied only when the
  // user hasn't picked one yet, never overrides an existing choice
  secondaryModel?: string;
  // full-URL overrides — replace the built-in engine/model sources entirely
  whisperBinUrl?: string;
  whisperModelUrl?: string;
  piperBinUrl?: string;
  ttsVoiceUrl?: string;
  ttsVoiceCfgUrl?: string;
};

const GGML = /^ggml-[\w.+-]+\.bin$/;
const PIPER_ID = /^[a-z]{2}_[A-Z]{2,3}-[\w-]+-(x_)?(low|medium|high)$/;
const HTTPS = /^https:\/\/[\w.-]+(:\d+)?\/\S+$/;

function isStr(v: unknown, re: RegExp): v is string {
  return typeof v === "string" && re.test(v);
}

// pure validator — node tests exercise this directly. returns null unless the
// body carries the two required ids; unknown fields are ignored so the file
// can grow ahead of shipped builds
export function parseReco(body: string): Reco | null {
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isStr(j?.whisperModel, GGML) || !isStr(j?.ttsVoice, PIPER_ID)) return null;
  const out: Reco = {
    version: typeof j.version === "number" ? j.version : 1,
    whisperModel: j.whisperModel,
    ttsVoice: j.ttsVoice,
  };
  if (typeof j.note === "string" && j.note.trim()) out.note = j.note.slice(0, 200);
  if (typeof j.secondaryModel === "string" && /^[\w.-]+\/[\w.:-]+$/.test(j.secondaryModel))
    out.secondaryModel = j.secondaryModel;
  for (const k of [
    "whisperBinUrl",
    "whisperModelUrl",
    "piperBinUrl",
    "ttsVoiceUrl",
    "ttsVoiceCfgUrl",
  ] as const) {
    if (isStr(j[k], HTTPS)) out[k] = j[k];
  }
  return out;
}

const CACHE_KEY = "oc.reco";
const CACHE_TTL = 7 * 24 * 3600 * 1000;

// the suggested secondary model must exist in the live provider list AND be
// on a free tier — zen's free models all carry a "-free" suffix, the only
// pricing signal the client ever sees
export function recoModelOk(
  model: string | undefined,
  providers: { id: string; models: { id: string }[] }[],
): boolean {
  if (!model || !model.includes("/")) return false;
  const slash = model.indexOf("/");
  const pid = model.slice(0, slash);
  const mid = model.slice(slash + 1);
  if (!pid || !mid.endsWith("-free")) return false;
  return providers.some((g) => g.id === pid && g.models.some((m) => m.id === mid));
}

// cached spec; falls back to built-ins when offline or RECO_URL is unset
export async function loadRecommended(force = false): Promise<Reco> {
  if (!force) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw) as { at: number; data: Reco };
        if (c.data?.whisperModel && Date.now() - c.at < CACHE_TTL) return c.data;
      }
    } catch {}
  }
  if (!RECO_URL) return { ...DEFAULT_RECO };
  try {
    const r = await invoke<{ status: number; body: string }>("http_json", {
      method: "GET",
      url: RECO_URL,
      headers: {},
      body: null,
    });
    const parsed = r.status === 200 ? parseReco(r.body) : null;
    if (parsed) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: parsed }));
      return parsed;
    }
  } catch {}
  return { ...DEFAULT_RECO };
}
