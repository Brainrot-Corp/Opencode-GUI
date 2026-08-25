// Tuya light helpers — DP-code detection, value mapping and the executor the
// voice dispatcher calls. Transport lives Rust-side (src-tauri/src/tuya.rs).
import { invoke } from "@tauri-apps/api/core";

export type TuyaConf = { clientId: string; secret: string; region: string; uid: string };

export type LightAct =
  | { type: "light"; sw: "on" | "off"; name: string }
  | { type: "lightBright"; pct: number; name: string }
  | { type: "lightTemp"; tone: string; name: string }
  | { type: "lightColor"; color: string; name: string };

type Dev = {
  id: string;
  name: string;
  category: string;
  online: boolean;
  status?: { code: string; value: unknown }[] | null;
};

// spoken color words → hue (degrees)
const HUE: Record<string, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  cyan: 180,
  blue: 240,
  purple: 280,
  violet: 280,
  magenta: 320,
  pink: 330,
};

// warmth presets on the v2 temp scale (0 = coldest … 1000 = warmest)
const TEMP_TONE: Record<string, number> = { cool: 60, daylight: 300, neutral: 480, warm: 880 };

// short-lived cache — the cloud round trip is ~1s, and consecutive voice
// commands ("lights on" → "dim them") shouldn't refetch every time
let cache: { at: number; devs: Dev[] } | null = null;

export function clearTuyaCache() {
  cache = null;
}

export function confReady(c: TuyaConf): boolean {
  return !!(c.clientId && c.secret && c.uid);
}

async function lights(c: TuyaConf): Promise<Dev[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.devs;
  const devs = await invoke<Dev[]>("tuya_lights", {
    creds: { client_id: c.clientId, secret: c.secret, region: c.region, uid: c.uid },
  });
  cache = { at: Date.now(), devs };
  return devs;
}

// resolve a spoken fragment ("desk", "bedroom") against device names;
// empty fragment = everything online
function find(devs: Dev[], frag: string): Dev[] {
  const online = devs.filter((d) => d.online);
  const pool = online.length ? online : devs;
  const f = frag.trim().toLowerCase();
  if (!f) return pool;
  const sub = pool.filter((d) => d.name.toLowerCase().includes(f));
  if (sub.length) return sub;
  const toks = f.split(/\s+/).filter(Boolean);
  return pool.filter((d) => {
    const n = d.name.toLowerCase();
    return toks.some((t) => n.includes(t));
  });
}

function hasCode(d: Dev, base: string): string | null {
  const st = d.status ?? [];
  if (st.some((s) => s.code === `${base}_v2`)) return `${base}_v2`;
  if (st.some((s) => s.code === base)) return base;
  return null;
}

export function brightVal(pct: number, v2: boolean): number {
  const min = v2 ? 10 : 25;
  const max = v2 ? 1000 : 255;
  return Math.max(min, Math.min(max, Math.round((Math.max(1, Math.min(100, pct)) / 100) * max)));
}

export function tempVal(tone: string, v2: boolean): number {
  const t = TEMP_TONE[tone] ?? 480;
  return v2 ? t : Math.round(t * 0.255);
}

// colour_data(_v2) packing: newer firmware reports/accepts a JSON string
// ({"h":..,"s":..,"v":..}), older expects packed hex hhhhssssvvvv — mirror
// whatever shape the device currently reports
function pack4(n: number): string {
  return Math.max(0, Math.min(0xffff, Math.round(n))).toString(16).padStart(4, "0");
}

export function colorData(word: string, v2: boolean, cur?: unknown): unknown {
  const max = v2 ? 1000 : 255;
  const hsv = { h: HUE[word] ?? 0, s: max, v: max };
  if (typeof cur === "string" && cur.trim().startsWith("{")) return JSON.stringify(hsv);
  if (cur && typeof cur === "object") return hsv;
  return `${pack4(hsv.h)}${pack4(max)}${pack4(max)}`;
}

function credsOf(c: TuyaConf) {
  return { client_id: c.clientId, secret: c.secret, region: c.region, uid: c.uid };
}

export async function testCreds(c: TuyaConf): Promise<string[]> {
  cache = null;
  const devs = await invoke<Dev[]>("tuya_lights", { creds: credsOf(c) });
  return devs.map((d) => d.name);
}

// runs one voice intent against the linked lights; resolves to a spoken
// summary, throws a human-readable error otherwise
export async function runLightAct(c: TuyaConf, act: LightAct): Promise<string> {
  if (!confReady(c)) throw new Error("not configured — see Settings › Lights");
  const devs = await lights(c);
  if (!devs.length) throw new Error("no linked lights found");
  const targets = find(devs, act.name);
  if (!targets.length) throw new Error(`no light matches "${act.name}"`);

  const sent: string[] = [];
  const skipped: string[] = [];
  for (const d of targets) {
    const cmds: [string, unknown][] = [];
    const st = d.status ?? [];
    const mode = (m: string) => st.some((s) => s.code === "work_mode") && cmds.push(["work_mode", m]);
    let ok = true;
    switch (act.type) {
      case "light":
        cmds.push(["switch_led", act.sw === "on"]);
        break;
      case "lightBright": {
        const code = hasCode(d, "bright_value");
        if (!code) ok = false;
        else {
          mode("white");
          cmds.push([code, brightVal(act.pct, code.endsWith("_v2"))]);
        }
        break;
      }
      case "lightTemp": {
        const code = hasCode(d, "temp_value");
        if (!code) ok = false;
        else {
          mode("white");
          cmds.push([code, tempVal(act.tone, code.endsWith("_v2"))]);
        }
        break;
      }
      case "lightColor": {
        const code = hasCode(d, "colour_data");
        if (!code || !(act.color in HUE)) ok = false;
        else {
          mode("colour");
          const cur = st.find((s) => s.code === code)?.value;
          cmds.push([code, colorData(act.color, code.endsWith("_v2"), cur)]);
        }
        break;
      }
    }
    if (!ok) {
      skipped.push(d.name);
      continue;
    }
    await invoke("tuya_send", { creds: credsOf(c), deviceId: d.id, commands: cmds });
    sent.push(d.name);
  }
  if (!sent.length) throw new Error(`${targets[0].name} doesn't support that`);

  const nm = (list: string[]) => (list.length === 1 ? list[0] : `${list.length} lights`);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let msg: string;
  switch (act.type) {
    case "light":
      msg = act.sw === "on" ? `${cap(nm(sent))} on.` : `${cap(nm(sent))} off.`;
      break;
    case "lightBright":
      msg = `${cap(nm(sent))} set to ${act.pct}% brightness.`;
      break;
    case "lightTemp":
      msg = `${cap(nm(sent))}: ${act.tone} white.`;
      break;
    case "lightColor":
      msg = `${cap(nm(sent))} is now ${act.color}.`;
      break;
  }
  if (skipped.length) msg += ` (${skipped.join(", ")} skipped.)`;
  return msg;
}
