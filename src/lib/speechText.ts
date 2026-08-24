import type { Msg } from "../types";

// plays synthesized wav bytes; returns the element so callers can pause it
export function playWav(bytes: number[], volume: number): HTMLAudioElement {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
  );
  const a = new Audio(url);
  a.volume = volume;
  a.onended = () => URL.revokeObjectURL(url);
  // tell the voice hook piper is audible so hands-free VAD gates its echo
  a.addEventListener("play", () => {
    const ms = Number.isFinite(a.duration) ? a.duration * 1000 : 3000;
    window.dispatchEvent(new CustomEvent<number>("oc:tts-live", { detail: ms }));
  });
  void a.play().catch(() => a.dispatchEvent(new Event("error")));
  return a;
}

// all text-part content of a message, joined — streaming deltas included
export function full_text(m: Msg): string {
  return m.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join(" ");
}

// batched tool roll-up — built to sound like a person giving a status blip:
// fuzzy quantities, rotating verbs/openers, at most two named items, and an
// anti-repeat guard so consecutive ticks never parrot the same sentence
const TOOL_SAY: Record<string, { v: string[]; n?: [string, string] }> = {
  read: { v: ["read", "skimmed", "looked through"], n: ["file", "files"] },
  write: { v: ["wrote", "created"], n: ["file", "files"] },
  edit: { v: ["edited", "updated", "tweaked"], n: ["file", "files"] },
  multiedit: { v: ["edited", "reworked"], n: ["file", "files"] },
  patch: { v: ["patched"], n: ["file", "files"] },
  bash: { v: ["ran", "kicked off"], n: ["command", "commands"] },
  grep: { v: ["searched the codebase", "dug through the code"] },
  glob: { v: ["scouted out candidate files", "rounded up matching files"] },
  list: { v: ["mapped out some folders", "listed directories"] },
  webfetch: { v: ["fetched", "pulled up"], n: ["web page", "web pages"] },
  websearch: { v: ["searched the web", "looked something up online"] },
  task: { v: ["delegated part of the work to a subagent"] },
  todowrite: { v: ["updated its plan", "jotted down next steps"] },
  question: { v: ["asked you something"] },
};
let lastSay = "";
const sayPick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const qtyWord = (n: number) =>
  n <= 1 ? "a" : n === 2 ? "a couple of" : n <= 4 ? "a few" : n <= 8 ? "several" : "a bunch of";

function describeTool(tool: string, n: number): string {
  const t = TOOL_SAY[tool];
  if (!t) return `ran a ${tool} step`;
  const verb = sayPick(t.v);
  if (!t.n) return verb; // verb already carries the object ("searched the codebase")
  return `${verb} ${qtyWord(n)} ${n === 1 ? t.n[0] : t.n[1]}`;
}

function buildOne(counts: Map<string, number>): string {
  const items = [...counts.entries()].map(([tool, n]) => describeTool(tool, n));
  let body: string;
  if (items.length === 1) {
    body = sayPick(["", "just ", "so far — "]) + items[0];
  } else if (items.length === 2) {
    body = sayPick([`${items[0]}, then ${items[1]}`, `${items[0]} and also ${items[1]}`, `${items[0]} — plus ${items[1]}`]);
  } else {
    // don't enumerate blindly — name two, wave at the rest
    body = `${items[0]} and ${items[1]}, among other things`;
  }
  const s = body.trim();
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

export function buildEnumPhrase(counts: Map<string, number>): string {
  if (!counts.size) return "";
  let phrase = buildOne(counts);
  for (let i = 0; phrase === lastSay && i < 4; i++) phrase = buildOne(counts);
  lastSay = phrase;
  return phrase;
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function lowVariantFor(modelSel: string, providers: { id: string; models: { id: string; variants?: string[] }[] }[]): string | undefined {
  const i = modelSel.indexOf("/");
  const pid = i < 0 ? modelSel : modelSel.slice(0, i);
  const mid = i < 0 ? "" : modelSel.slice(i + 1);
  const prov = providers.find((g) => g.id === pid);
  const m = prov?.models.find((x) => x.id === mid);
  const vars = m?.variants ?? [];
  if (vars.includes("low")) return "low";
  if (vars.includes("minimal")) return "minimal";
  if (vars.includes("fast")) return "fast";
  return undefined;
}

// markdown scrub for mid-stream narration — complete code blocks become a
// placeholder, an open fence holds its text back until it closes
export const cleanSpeech = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/```[\s\S]*$/, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/\s{2,}/g, " ")
    .trim();
