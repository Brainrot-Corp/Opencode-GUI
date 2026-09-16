import type { Session } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";

// /debug-long-session — synthetic history for load-testing the chat list
// (tail window, LazyRow placeholder upgrades, adaptive load chain). Fake
// sessions live only in memory: the id prefix marks them so every server
// touchpoint (fetches, SSE, prompts) can be skipped.
export const DEBUG_PREFIX = "debug-long-";

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum".split(" ");

function para(seed: number, words: number): string {
  let out = "";
  for (let i = 0; i < words; i++) out += WORDS[(seed * 7919 + i * 31) % WORDS.length] + " ";
  return out.trim();
}

const LANGS = ["typescript", "python", "rust", "go", "sql"];
function fence(seed: number, lines: number): string {
  const lang = LANGS[seed % LANGS.length];
  let body = "";
  for (let i = 0; i < lines; i++) {
    const w = WORDS[(seed + i) % WORDS.length];
    body += `  // line ${i + 1}: ${w} ${w} ${w} = ${(seed * i) % 1000};\n`;
  }
  return "```" + lang + "\n" + body + "```\n";
}

export function parseDebugCount(args: string): number {
  const n = parseInt(args?.trim() ?? "", 10);
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : 3000, 10), 20000);
}

// alternating user prompts + assistant replies with markdown, gfm tables,
// fenced code (Monaco + rehype-highlight), reasoning blocks and step chips;
// every 13th reply is huge (tall rows) and every ~20th user prompt is empty
// text (rowVisible filter) — sizes vary so placeholder upgrades have real
// deltas to compensate
export function makeFakeMessages(sid: string, count: number): Msg[] {
  const out: Msg[] = [];
  const t0 = Date.now() - count * 60_000;
  for (let i = 0; i < count; i++) {
    const ts = t0 + i * 60_000;
    const id = `dbg-${sid}-${i}`;
    const role = i % 2 === 0 ? "user" : "assistant";
    const info: any = {
      id,
      sessionID: sid,
      role,
      time: { created: ts, completed: ts },
      parentID: "",
      modelID: role === "assistant" ? "filler" : "",
      providerID: role === "assistant" ? "debug" : "",
      mode: "build",
      path: { cwd: "", root: "" },
    };
    if (role === "assistant") {
      info.cost = 0;
      info.tokens = { input: 1000 + i, output: 200 + i, reasoning: 0, cache: { read: 0, write: 0 } };
    }
    const parts: any[] = [];
    if (role === "user") {
      parts.push({
        id: `${id}-p0`,
        type: "text",
        sessionID: sid,
        messageID: id,
        text: i % 41 === 20 ? "   " : `fake prompt #${i}: ${para(i, i % 7 === 0 ? 120 : 12)}`,
      });
    } else {
      if (i % 5 === 1) {
        parts.push({
          id: `${id}-r`,
          type: "reasoning",
          sessionID: sid,
          messageID: id,
          text: `${para(i, 80)}\n\n${para(i + 3, 80)}`,
        });
      }
      const big = i % 13 === 3;
      let md = "";
      for (let p = 0; p < (big ? 6 : 2); p++) {
        md += `## filler ${p} (msg ${i})\n\n${para(i * 7 + p, big ? 400 : 60)}\n\n`;
      }
      md += `- point one: ${para(i, 20)}\n- point two: ${para(i + 1, 20)}\n\n`;
      md += `| col a | col b |\n|---|---|\n| ${para(i, 5)} | ${para(i + 2, 5)} |\n\n`;
      for (let f = 0; f < (big ? 4 : 1); f++) md += fence(i * 3 + f, big ? 120 : 30);
      parts.push({ id: `${id}-t`, type: "text", sessionID: sid, messageID: id, text: md });
      if (i % 4 === 3) {
        parts.push({
          id: `${id}-s`,
          type: "step-finish",
          sessionID: sid,
          messageID: id,
          tokens: { input: 900 + i, output: 150 + i, reasoning: 20 },
          cost: 0.0001,
        });
      }
    }
    out.push({ info, parts } as unknown as Msg);
  }
  return out;
}

export function fakeSession(id: string, count: number): Session {
  return {
    id,
    title: `DEBUG · ${count.toLocaleString()} filler messages`,
    time: { created: Date.now(), updated: Date.now() },
  } as unknown as Session;
}
