import type { Message, Part } from "@opencode-ai/sdk/client";

export type Msg = { info: Message; parts: Part[] };

export type PermAsk = { id: string; sessionID: string; type: string; title: string };

export type ProviderGroup = {
  id: string;
  label: string;
  models: {
    id: string;
    label: string;
    variants?: string[];
    // attachment support from GET /provider (missing metadata = allow all)
    attachment?: boolean;
    input?: string[];
  }[];
};

// staged attachment in the composer
export type Attachment = {
  id: string;
  mime: string;
  filename?: string;
  url: string; // data URL once ready, "" while reading
  size: number;
  status: "reading" | "ready" | "error";
  progress: number; // 0..1 read progress
  hash?: string; // sha256 of the data URL — draft duplicate detection
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
