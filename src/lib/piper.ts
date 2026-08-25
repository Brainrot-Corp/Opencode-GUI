// Piper neural voice data — engine/model download sources, locale labels and
// the full-voice-catalog browser feed. The catalog comes from the
// huggingface.co tree API (paginated via standard Link headers through the
// host's generic http_json command) so new upstream voices appear without
// shipping a list; the static slice below doubles as offline fallback.
import { invoke } from "@tauri-apps/api/core";

export const WHISPER_BIN_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";
export const MODEL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
export const VOICE_MODELS = [
  { id: "ggml-tiny.en.bin", label: "tiny.en · 78 MB · fastest, rougher" },
  { id: "ggml-base.en.bin", label: "base.en · 148 MB · English-only" },
  { id: "ggml-small.en.bin", label: "small.en · 488 MB · best accuracy, English-only" },
  { id: "ggml-base.bin", label: "base multilingual · 148 MB · recommended" },
];

export const PIPER_BIN_URL =
  "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
const PIPER_VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/";

function piperUrl(id: string, ext = ".onnx"): string {
  const [family, speaker, quality] = id.split("-");
  return `${PIPER_VOICE_BASE}${family.slice(0, 2)}/${family}/${speaker}/${quality}/${id}${ext}`;
}
export { piperUrl };

export const PIPER_VOICES = [
  "en_US-amy-medium",
  "en_US-lessac-medium",
  "en_US-ryan-high",
  "en_GB-alba-medium",
  "en_GB-southern_english_female-low",
  "de_DE-thorsten-medium",
  "fr_FR-siwis-medium",
  "es_ES-sharvard-medium",
  "zh_CN-huayan-medium",
  "pt_BR-faber-medium",
  "pl_PL-darkman-medium",
];

export const PIPER_LANGS: Record<string, string> = {
  en_US: "US English",
  en_GB: "British English",
  de_DE: "German",
  fr_FR: "French",
  es_ES: "Spanish",
  es_MX: "Mexican Spanish",
  zh_CN: "Chinese",
  pt_BR: "Brazilian Portuguese",
  pt_PT: "Portuguese",
  pl_PL: "Polish",
  ar_JO: "Arabic (Jordan)",
  ca_ES: "Catalan",
  cs_CZ: "Czech",
  cy_GB: "Welsh",
  da_DK: "Danish",
  el_GR: "Greek",
  fa_IR: "Persian",
  fi_FI: "Finnish",
  hu_HU: "Hungarian",
  is_IS: "Icelandic",
  it_IT: "Italian",
  ka_GE: "Georgian",
  kk_KZ: "Kazakh",
  nb_NO: "Norwegian",
  ne_NP: "Nepali",
  nl_NL: "Dutch",
  ro_RO: "Romanian",
  ru_RU: "Russian",
  sk_SK: "Slovak",
  sl_SI: "Slovenian",
  sr_RS: "Serbian",
  sv_SE: "Swedish",
  sw_CD: "Swahili",
  tr_TR: "Turkish",
  uk_UA: "Ukrainian",
  vi_VN: "Vietnamese",
};

export function piperLabel(id: string): string {
  const [family, speaker, quality] = id.split("-");
  return `${speaker} (${quality}) · ${PIPER_LANGS[family] ?? family}`;
}

const CATALOG_API =
  "https://huggingface.co/api/models/rhasspy/piper-voices/tree/v1.0.0?recursive=true&limit=1000";
const CACHE_KEY = "oc.piper.catalog";
const CACHE_TTL = 7 * 24 * 3600 * 1000;

// pure parser — node tests exercise this directly
export function parsePiperCatalog(body: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(j)) return [];
  const out = new Set<string>();
  for (const f of j) {
    const p = (f as { path?: unknown })?.path;
    if (typeof p === "string" && p.endsWith(".onnx")) {
      out.add(p.split("/").pop()!.replace(/\.onnx$/, ""));
    }
  }
  return [...out].sort();
}

type Page = { body: string; link: string };

// walk the paginated tree API; returns every voice id in the repo
async function fetchCatalogPages(): Promise<string[]> {
  const ids = new Set<string>();
  let url: string | null = CATALOG_API;
  for (let page = 0; url && page < 10; page++) {
    const r = await invoke<Page>("http_json", { method: "GET", url, headers: {}, body: null });
    for (const id of parsePiperCatalog(r.body)) ids.add(id);
    const m = /<([^>]+)>;\s*rel="next"/.exec(r.link ?? "");
    url = m ? m[1] : null;
  }
  return [...ids];
}

// cached full catalog; falls back to the curated static slice offline
export async function loadPiperCatalog(force = false): Promise<string[]> {
  if (!force) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw) as { at: number; ids: string[] };
        if (Array.isArray(c.ids) && c.ids.length > 0 && Date.now() - c.at < CACHE_TTL)
          return c.ids;
      }
    } catch {}
  }
  try {
    const fetched = await fetchCatalogPages();
    const merged = [...new Set([...PIPER_VOICES, ...fetched])].sort();
    if (merged.length > PIPER_VOICES.length) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), ids: merged }));
    }
    return merged;
  } catch {
    return [...PIPER_VOICES];
  }
}
