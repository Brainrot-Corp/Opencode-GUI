// Provider auth (/connect) — current-workspace server only.
// Wraps the three server endpoints the TUI uses:
//   GET  /provider/auth                  -> { [id]: { type: "oauth"|"api", label }[] }
//   PUT  /auth/{id} { type:"api", key }  -> boolean
//   POST /provider/{id}/oauth/authorize  -> { url, method: "auto"|"code", instructions }
//   POST /provider/{id}/oauth/callback   -> boolean
// Logout has no SDK endpoint — attempted as DELETE /auth/{id}; when the
// server rejects it the caller shows the manual auth.json path instead.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, opencodeFor, serverFetchFor, withDeadline } from "../api";

export type ProviderAuthMethod = { type: "oauth" | "api"; label: string };
export type ProviderAuthItem = { id: string; label: string; methods: ProviderAuthMethod[] };
export type OAuthStart = { url: string; method: "auto" | "code"; instructions: string };

function apiErr(r: unknown, fallback: string): string {
  const e = (r as any)?.error;
  if (!e) return "";
  if (typeof e === "string") return e;
  try {
    return (e as any)?.message ?? (e as any)?.data?.message ?? JSON.stringify(e);
  } catch {
    return fallback;
  }
}

async function getClient(dir: string) {
  const { client } = await withDeadline(opencodeFor(dir), 15_000, "provider auth");
  return client as any;
}

export function useProviderAuth() {
  const dir = getDirectory();
  const [items, setItems] = useState<ProviderAuthItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const d = getDirectory();
    if (alive.current) {
      setLoading(true);
      setError("");
    }
    try {
      const client = await getClient(d);
      const [authR, cfgR] = await Promise.all([
        withDeadline(client.provider.auth(), 15_000, "provider auth"),
        withDeadline(client.config.providers(), 15_000, "provider auth").catch(() => null),
      ]);
      const authErr = apiErr(authR, "provider auth rejected");
      if (authErr) throw new Error(authErr);
      const map = ((authR as any)?.data ?? {}) as Record<string, ProviderAuthMethod[]>;
      const labels = new Map<string, string>();
      for (const p of (((cfgR as any)?.data?.providers ?? []) as any[])) {
        if (p?.id) labels.set(p.id, p.name || p.id);
      }
      const out: ProviderAuthItem[] = Object.entries(map)
        .filter(([, m]) => Array.isArray(m) && m.length > 0)
        .map(([id, methods]) => ({ id, label: labels.get(id) || id, methods }))
        .sort((a, b) => a.label.localeCompare(b.label));
      if (alive.current) setItems(out);
    } catch (e) {
      if (alive.current) {
        setItems([]);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // API-key save. Key is trimmed, never stored or logged — cleared by the caller.
  // _method kept for symmetry with the OAuth calls (auth.set takes no method).
  const saveKey = useCallback(async (id: string, _method: number, key: string) => {
    const k = key.trim();
    if (!k) throw new Error("Paste an API key first.");
    const client = await getClient(getDirectory());
    setBusy(id);
    try {
      const r = await withDeadline(
        client.auth.set({ path: { id }, body: { type: "api", key: k } }),
        15_000,
        "provider auth",
      );
      const err = apiErr(r, "auth rejected");
      if (err) throw new Error(err);
      if ((r as any)?.data === false) throw new Error("Server refused the key.");
    } finally {
      setBusy(null);
    }
  }, []);

  // OAuth start — opens the browser like the MCP sign-in does.
  const beginOAuth = useCallback(async (id: string, method: number): Promise<OAuthStart> => {
    const client = await getClient(getDirectory());
    setBusy(id);
    try {
      const r = await withDeadline(
        client.provider.oauth.authorize({ path: { id }, body: { method } }),
        15_000,
        "provider auth",
      );
      const err = apiErr(r, "oauth rejected");
      if (err) throw new Error(err);
      const data = (r as any)?.data ?? {};
      if (!data.url) throw new Error("Server returned no authorization URL");
      try {
        await invoke("file_open", { path: data.url });
      } catch {}
      return { url: data.url, method: data.method ?? "code", instructions: data.instructions ?? "" };
    } finally {
      setBusy(null);
    }
  }, []);

  const submitCode = useCallback(async (id: string, method: number, code: string) => {
    const c = code.trim();
    if (!c) throw new Error("Paste the authorization code first.");
    const client = await getClient(getDirectory());
    setBusy(id);
    try {
      const r = await withDeadline(
        client.provider.oauth.callback({ path: { id }, body: { method, code: c } }),
        15_000,
        "provider auth",
      );
      const err = apiErr(r, "oauth rejected");
      if (err) throw new Error(err);
      if ((r as any)?.data === false) throw new Error("Server rejected the code.");
    } finally {
      setBusy(null);
    }
  }, []);

  // No SDK logout endpoint — DELETE usually 404s, in which case the dialog
  // shows the manual auth.json edit hint from the thrown message.
  const signOut = useCallback(async (id: string) => {
    const d = getDirectory();
    setBusy(id);
    try {
      const r = await withDeadline(
        serverFetchFor(d, `/auth/${encodeURIComponent(id)}`, { method: "DELETE" }),
        15_000,
        "provider logout",
      ).catch(() => null);
      if (r && r.ok) return;
      throw new Error(
        `No logout endpoint on this server — remove "${id}" from ~/.local/share/opencode/auth.json on the ${d || "local"} machine, then restart the sidecar.`,
      );
    } finally {
      setBusy(null);
    }
  }, []);

  return { dir, items, loading, busy, error, refresh, saveKey, beginOAuth, submitCode, signOut };
}
