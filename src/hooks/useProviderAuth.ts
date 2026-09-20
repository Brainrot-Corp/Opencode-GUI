// Provider auth (/connect) — current-workspace server only.
// Lists the full catalog like the TUI (GET /provider `all`) with methods
// from GET /provider/auth and a generic API-key fallback:
//   GET  /provider                     -> { all: [{ id, name }], connected }
//   GET  /provider/auth                -> { [id]: { type: "oauth"|"api", label }[] }
//   PUT  /auth/{id} { type:"api", key }  -> boolean
//   POST /provider/{id}/oauth/authorize  -> { url, method: "auto"|"code", instructions }
//   POST /provider/{id}/oauth/callback   -> boolean
// Logout has no SDK endpoint — attempted as DELETE /auth/{id}; when the
// server rejects it the caller shows the manual auth.json path instead.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, serverFetchFor, withDeadline } from "../api";
import { apiErr, getClientFor } from "../lib/apiErr";

export type AuthPromptWhen = { key: string; op: "eq" | "neq"; value: string };
export type AuthPrompt =
  | { type: "text"; key: string; message: string; placeholder?: string; when?: AuthPromptWhen }
  | {
      type: "select";
      key: string;
      message: string;
      options: { label: string; value: string; hint?: string }[];
      when?: AuthPromptWhen;
    };
export type ProviderAuthMethod = { type: "oauth" | "api"; label: string; prompts?: AuthPrompt[] };
export type ProviderAuthItem = {
  id: string;
  label: string;
  methods: ProviderAuthMethod[];
  connected?: boolean;
  popular?: boolean;
  note?: string;
};
export type OAuthStart = { url: string; method: "auto" | "code"; instructions: string };

// TUI parity (dialog-provider.tsx): popular ids sort first in this order,
// everything else alphabetically by name with id tiebreak.
const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
};
const PROVIDER_NOTES: Record<string, string> = {
  opencode: "(Recommended)",
  anthropic: "(API key)",
  openai: "(ChatGPT Plus/Pro or API key)",
  "opencode-go": "Low cost subscription for everyone",
};

// TUI PromptsMethod `when` semantics: a conditional prompt is skipped while
// its referenced key is still unanswered.
export function visiblePrompts(
  prompts: AuthPrompt[] | undefined,
  inputs: Record<string, string>,
): AuthPrompt[] {
  if (!prompts?.length) return [];
  return prompts.filter((p) => {
    const w = p.when;
    if (!w) return true;
    const v = inputs[w.key];
    if (v === undefined) return false;
    return w.op === "eq" ? v === w.value : v !== w.value;
  });
}

function sortProviders<T extends { id: string; label: string }>(items: T[]): T[] {
  const rank = (id: string) => PROVIDER_PRIORITY[id] ?? 99;
  items.sort(
    (a, b) =>
      rank(a.id) - rank(b.id) ||
      a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return items;
}

const getClient = (dir: string) => getClientFor(dir, "provider auth");

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
      // TUI /connect lists the full catalog (GET /provider `all`, ~200
      // entries) and falls back to a generic API-key method when
      // GET /provider/auth has no entry for that id. Auth-only listing
      // showed ~10 providers and hid anthropic/openai/google/etc.
      const [authR, listR] = await Promise.all([
        withDeadline(client.provider.auth(), 15_000, "provider auth"),
        withDeadline(client.provider.list(), 15_000, "provider auth").catch(() => null),
      ]);
      const authErr = apiErr(authR, "provider auth rejected");
      if (authErr) throw new Error(authErr);
      const map = ((authR as any)?.data ?? {}) as Record<string, ProviderAuthMethod[]>;
      const all = (((listR as any)?.data?.all ?? []) as any[]).filter((p) => p?.id);
      const connected = new Set<string>(((listR as any)?.data?.connected ?? []) as string[]);
      const seen = new Set(all.map((p) => p.id as string));
      const out: ProviderAuthItem[] = all.map((p) => ({
        id: p.id,
        label: p.name || p.id,
        methods:
          Array.isArray(map[p.id]) && map[p.id].length > 0
            ? map[p.id]
            : [{ type: "api", label: "API key" }],
        connected: connected.has(p.id),
        popular: p.id in PROVIDER_PRIORITY,
        note: PROVIDER_NOTES[p.id],
      }));
      // auth-only ids (custom/plugin providers not in the catalog) still show
      for (const [id, methods] of Object.entries(map)) {
        if (seen.has(id) || !Array.isArray(methods) || methods.length === 0) continue;
        out.push({
          id,
          label: id,
          methods,
          connected: connected.has(id),
          popular: id in PROVIDER_PRIORITY,
          note: PROVIDER_NOTES[id],
        });
      }
      sortProviders(out);
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
  // inputs carries the method's extra prompts (e.g. Azure resourceName) as
  // `metadata`, matching `opencode auth login` (providers.ts).
  const saveKey = useCallback(async (id: string, _method: number, key: string, inputs?: Record<string, string>) => {
    const k = key.trim();
    if (!k) throw new Error("Paste an API key first.");
    const client = await getClient(getDirectory());
    setBusy(id);
    try {
      const r = await withDeadline(
        client.auth.set({
          path: { id },
          body: {
            type: "api",
            key: k,
            ...(inputs && Object.keys(inputs).length ? { metadata: inputs } : {}),
          },
        }),
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

  // OAuth start — prompts (e.g. GitLab instance URL) go as `inputs`, like the
  // TUI's PromptsMethod → authorize. Opens the browser like the MCP sign-in.
  const beginOAuth = useCallback(async (id: string, method: number, inputs?: Record<string, string>): Promise<OAuthStart> => {
    const client = await getClient(getDirectory());
    setBusy(id);
    try {
      const r = await withDeadline(
        client.provider.oauth.authorize({
          path: { id },
          body: { method, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) },
        }),
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
