// Per-workspace selection memory + last-used globals.
//
// Two needs, one store:
// 1. The first (primary) window restores its workspace AND that workspace's
//    last-used model / agent / effort / security on boot; switching to a
//    previously-used workspace re-applies what was last used inside it.
// 2. A secondary window boots with no workspace, but its pickers start at
//    the last-used values (from whichever window used them last), then live
//    independently afterwards.
//
// Both are HISTORY, deliberately shared across windows (unscoped keys):
// entries are keyed by workspace dir (or merged as "last of anything"), so
// concurrent windows write different fields/keys and never steer each other.
// Writes always read-merge first to avoid read-modify-write clobber.
import { getDirectory } from "../api";
import { normWorkspace } from "./platform";
import { windowKey } from "./windowScope";

const PREFS_KEY = "oc.workspacePrefs";
const LAST_KEY = "oc.lastGlobal";

export type WorkspacePref = {
  model?: string;
  agent?: string;
  variant?: string;
  security?: string;
};

function validStr(v: unknown, max = 256): string | undefined {
  return typeof v === "string" && v && v.length <= max ? v : undefined;
}

function validSecurity(v: unknown): string | undefined {
  if (v === "restricted") return "block";
  return v === "full" || v === "block" || v === "user" ? (v as string) : undefined;
}

function clean(raw: unknown): WorkspacePref {
  const out: WorkspacePref = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const model = validStr(r.model);
  const agent = validStr(r.agent, 128);
  const variant = validStr(r.variant, 64);
  const security = validSecurity(r.security);
  if (model) out.model = model;
  if (agent) out.agent = agent;
  if (variant !== undefined) out.variant = variant;
  if (security) out.security = security;
  return out;
}

function readBlob(): Record<string, WorkspacePref> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, WorkspacePref> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof k !== "string" || !k || k.length > 2048) continue;
      const c = clean(v);
      if (c.model !== undefined || c.agent !== undefined || c.variant !== undefined || c.security !== undefined) {
        out[k] = c;
        if (Object.keys(out).length >= 60) break;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// last-used selections for a workspace dir ("" = none — the empty/server-cwd
// pseudo-workspace remembers nothing so a blank window never inherits).
export function getWorkspacePref(dir: string): WorkspacePref {
  const t = (dir ?? "").trim();
  if (!t) return {};
  try {
    return readBlob()[normWorkspace(t)] ?? {};
  } catch {
    return {};
  }
}

export function setWorkspacePref(dir: string, patch: WorkspacePref): void {
  const t = (dir ?? "").trim();
  if (!t) return;
  const c = clean(patch);
  if (c.model === undefined && c.agent === undefined && c.variant === undefined && c.security === undefined) return;
  try {
    const blob = readBlob();
    blob[normWorkspace(t)] = { ...(blob[normWorkspace(t)] ?? {}), ...c };
    localStorage.setItem(PREFS_KEY, JSON.stringify(blob));
  } catch {}
}

// last-used selections across all windows ("last one used by the last opened
// window"). Write-only history for live windows; read once to seed a fresh
// secondary window, then never adopted again.
export function getLastGlobal(): WorkspacePref {
  try {
    return clean(JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export function setLastGlobal(patch: WorkspacePref): void {
  const c = clean(patch);
  if (c.model === undefined && c.agent === undefined && c.variant === undefined && c.security === undefined) return;
  try {
    const cur = getLastGlobal();
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...cur, ...c }));
  } catch {}
}

// record a user-visible selection: shared last-used + this window's
// workspace memory. Safe to call from restore paths too — it only writes
// back the values already in effect (idempotent).
export function recordSelection(patch: WorkspacePref): void {
  setLastGlobal(patch);
  try {
    setWorkspacePref(getDirectory(), patch);
  } catch {}
}

// Seed a fresh secondary window's namespaced globals from last-used values
// (shared lastGlobal first, legacy unscoped keys as fallback for installs
// predating it). Runs pre-render in main.tsx; hook initializers pick the
// seeded values up through windowKey(). Never overwrites: scoped keys are
// fresh per process, except after a same-process reload where the window's
// own newer values must win — so only fill empty slots.
export function seedSecondaryGlobals(): void {
  try {
    const g = getLastGlobal();
    let legacyModel = "";
    let legacyAgent = "";
    let legacySecurity = "";
    let legacyVariants = "";
    try {
      legacyModel = localStorage.getItem("oc.lastModel") ?? "";
      legacyAgent = localStorage.getItem("oc.lastAgent") ?? "";
      legacySecurity = localStorage.getItem("oc.securityMode") ?? "";
      legacyVariants = localStorage.getItem("oc.variants") ?? "";
    } catch {}
    const fill = (base: string, v: string) => {
      if (!v) return;
      const k = windowKey(base);
      if (k === base) return;
      try {
        if (!localStorage.getItem(k)) localStorage.setItem(k, v);
      } catch {}
    };
    fill("oc.lastModel", g.model ?? legacyModel);
    fill("oc.lastAgent", g.agent ?? legacyAgent);
    const sec = g.security ?? validSecurity(legacySecurity) ?? "";
    fill("oc.securityMode", sec);
    // per-model effort map: copy the whole table so the secondary starts
    // with the same efforts, then diverges independently afterwards.
    if (legacyVariants) fill("oc.variants", legacyVariants);
  } catch {}
}
