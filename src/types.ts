import type { Message, Part } from "@opencode-ai/sdk/client";

export type Msg = { info: Message; parts: Part[] };

export type PermAsk = { id: string; sessionID: string; type: string; title: string };

export type ProviderGroup = {
  id: string;
  label: string;
  models: { id: string; label: string }[];
};

export type OpenCodeEvent = { type: string; properties: any };
