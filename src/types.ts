import type { Message, Part } from "@opencode-ai/sdk/client";

export type Msg = { info: Message; parts: Part[] };

export type PermAsk = { id: string; sessionID: string; type: string; title: string };

export type ProviderGroup = {
  id: string;
  label: string;
  models: { id: string; label: string; variants?: string[] }[];
};

// GET /command entry — SDK type is stale (no source/hints)
export type Cmd = {
  name: string;
  description?: string;
  template?: string;
  source?: string;
  hints?: string[];
};

export type OpenCodeEvent = { type: string; properties: any };
