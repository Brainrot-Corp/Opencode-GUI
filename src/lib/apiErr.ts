import { opencodeFor, withDeadline } from "../api";

// the SDK never throws on API errors (ThrowOnError=false) — callers must
// check the response's .error field; this surfaces it as a message
export function apiErr(r: unknown, fallback: string): string {
  const e = (r as any)?.error;
  if (!e) return "";
  if (typeof e === "string") return e;
  try {
    return (e as any)?.message ?? (e as any)?.data?.message ?? JSON.stringify(e);
  } catch {
    return fallback;
  }
}

// opencodeFor has no deadline of its own — a dead SSH workspace dial would
// hang the caller (and via Promise.all, the whole dialog) indefinitely.
// Reject instead.
export async function getClientFor(dir: string, label: string) {
  const { client } = await withDeadline(opencodeFor(dir), 15_000, label);
  return client as any;
}
