import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { invoke } from "@tauri-apps/api/core";

let cached: Promise<{ base: string; client: ReturnType<typeof createOpencodeClient> }> | null =
  null;

export function opencode() {
  cached ??= invoke<string>("server_url").then((base) => ({
    base,
    client: createOpencodeClient({ baseUrl: base }),
  }));
  return cached;
}
