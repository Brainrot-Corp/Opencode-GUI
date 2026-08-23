import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "@opencode-ai/sdk/client";
import { opencode } from "../api";
import { playSound } from "../lib/sounds";
import type { Cmd } from "../types";

// slash-command entries surfaced in the composer: app built-ins first,
// then the server registry (custom + plugin + skill commands)
export type CmdEntry = {
  name: string;
  description: string;
  source: string;
  takesArgs: boolean;
  builtin?: boolean;
};

export type DialogState =
  | { kind: "help" }
  | { kind: "share"; url: string }
  | { kind: "variants" }
  | null;

export type SlashCtx = {
  // session state
  activeId: string;
  sessions: Session[];
  agents: { name: string; mode: string }[];
  agentSel: string;
  variantSel: string;
  modelSel: string;
  defaultModel: string;
  modelVariants: string[];
  commands: Cmd[];
  undoTarget: string;
  revertId: string;
  isBusy: (id: string) => boolean;
  setBusy: (id: string, on: boolean) => void;
  setError: (e: string) => void;
  // fired just before a server-registry command runs — lets the owner stop
  // treating the next model selection as explicit (so replies teach defaultModel)
  onRegistryCommand?: () => void;
  openDialog: (d: DialogState) => void;
  // actions owned by the hook
  newSession(): Promise<void>;
  revertTo(messageID: string): Promise<void>;
  unrevert(): Promise<void>;
  cycleAgent(): void;
  refreshSessions(): Promise<Session[]>;
  openSession(id: string): Promise<void>;
};

const SLASH_RE = /^\/([\w-]+)(?:\s+([\s\S]*))?$/;

// built-in dispatch. returns true when handled; false lets the caller fall
// through to a plain prompt send.
export async function handleSlash(text: string, ctx: SlashCtx): Promise<boolean> {
  const slash = SLASH_RE.exec(text.trim());
  if (!slash) return false;
  const [, name, args] = slash;

  // commands that work with or without an open session
  switch (name) {
    case "help":
      ctx.openDialog({ kind: "help" });
      return true;
    case "variants":
      ctx.openDialog({ kind: "variants" });
      return true;
    case "thinking":
    case "collapse":
      playSound("click");
      window.dispatchEvent(new Event("oc:collapse"));
      return true;
    case "exit":
      playSound("close");
      getCurrentWindow().close();
      return true;
    case "models":
    case "themes":
    case "scheme":
    case "diff":
    case "settings":
      // UI toggles owned by components — hand off over a namespaced event
      playSound("click");
      window.dispatchEvent(new Event(`oc:${name}`));
      return true;
  }

  const id = ctx.activeId;

  if (id) {
    switch (name) {
      case "new":
        await ctx.newSession();
        return true;
      case "undo":
        if (ctx.undoTarget && !ctx.isBusy(id)) await ctx.revertTo(ctx.undoTarget);
        return true;
      case "redo":
        if (ctx.revertId) await ctx.unrevert();
        return true;
      case "compact": {
        if (ctx.isBusy(id)) return true;
        const sel = ctx.modelSel || ctx.defaultModel;
        if (!sel) return true;
        const [providerID, modelID] = sel.split("/");
        ctx.setBusy(id, true);
        const { client } = await opencode();
        try {
          await client.session.summarize({ path: { id }, body: { providerID, modelID } });
        } catch (e) {
          ctx.setBusy(id, false);
          ctx.setError(String(e));
        }
        return true;
      }
      case "share": {
        const { client } = await opencode();
        try {
          await client.session.share({ path: { id } });
          const r = await client.session.get({ path: { id } });
          const url = (r.data as any)?.share?.url ?? "";
          if (url) ctx.openDialog({ kind: "share", url });
          else ctx.setError("Sharing is disabled in this build's config");
        } catch (e) {
          ctx.setError(String(e));
        }
        return true;
      }
      case "unshare": {
        const { client } = await opencode();
        await client.session.unshare({ path: { id } }).catch((e) => ctx.setError(String(e)));
        return true;
      }
      case "fork": {
        if (ctx.isBusy(id)) return true;
        const { client } = await opencode();
        try {
          const r = await client.session.fork({ path: { id } });
          const s = r.data as Session;
          await ctx.refreshSessions();
          await ctx.openSession(s.id);
        } catch (e) {
          ctx.setError(String(e));
        }
        return true;
      }
      case "next":
      case "prev": {
        if (!id || ctx.sessions.length < 2) return true;
        const i = ctx.sessions.findIndex((s) => s.id === id);
        const next =
          ctx.sessions[(i + (name === "next" ? 1 : ctx.sessions.length - 1)) % ctx.sessions.length];
        await ctx.openSession(next.id);
        return true;
      }
      case "agents":
        ctx.cycleAgent();
        return true;
    }

    // server registry: custom + plugin + skill commands
    const reg = ctx.commands.find((c) => c.name === name);
    if (reg) {
      if (ctx.isBusy(id)) return true;
      ctx.setBusy(id, true);
      ctx.onRegistryCommand?.();
      const { client } = await opencode();
      try {
        const body: any = { command: name, arguments: args ?? "" };
        if (ctx.agentSel) body.agent = ctx.agentSel;
        if (ctx.variantSel) body.variant = ctx.variantSel;
        await client.session.command({ path: { id }, body });
      } catch (e) {
        ctx.setBusy(id, false);
        ctx.setError(String(e));
      }
      return true;
    }
  }

  // unknown / unhandled — treat as a plain prompt
  return false;
}

// unified list for the composer autocomplete — built-ins first
export function buildCmdList(
  commands: Cmd[],
  opts: {
    agents: { name: string; mode: string }[];
    agentSel: string;
    modelVariants: string[];
    variantSel: string;
  },
): CmdEntry[] {
  const { agentSel, agents, modelVariants, variantSel } = opts;
  const builtins: CmdEntry[] = [
    { name: "new", description: "Start a new session", source: "built-in", takesArgs: false, builtin: true },
    { name: "undo", description: "Undo the last message", source: "built-in", takesArgs: false, builtin: true },
    { name: "redo", description: "Redo the last undone message", source: "built-in", takesArgs: false, builtin: true },
    { name: "compact", description: "Summarize the session to reduce context size", source: "built-in", takesArgs: false, builtin: true },
    { name: "fork", description: "Create a new session from this one", source: "built-in", takesArgs: false, builtin: true },
    { name: "share", description: "Share this session and copy the URL", source: "built-in", takesArgs: false, builtin: true },
    { name: "unshare", description: "Stop sharing this session", source: "built-in", takesArgs: false, builtin: true },
    { name: "models", description: "Choose a model", source: "built-in", takesArgs: false, builtin: true },
    {
      name: "variants",
      description: modelVariants.length
        ? `Select thinking effort (current: ${variantSel || "default"})`
        : "Select thinking effort — current model has none",
      source: "built-in",
      takesArgs: false,
      builtin: true,
    },
    {
      name: "agents",
      description: `Switch agent (current: ${agentSel || agents[0]?.name || "build"})`,
      source: "built-in",
      takesArgs: false,
      builtin: true,
    },
    { name: "collapse", description: "Toggle whether thinking & tool blocks start collapsed", source: "built-in", takesArgs: false, builtin: true },
    { name: "themes", description: "Cycle UI theme", source: "built-in", takesArgs: false, builtin: true },
    { name: "scheme", description: "Toggle dark / light mode", source: "built-in", takesArgs: false, builtin: true },
    { name: "next", description: "Open the next session", source: "built-in", takesArgs: false, builtin: true },
    { name: "prev", description: "Open the previous session", source: "built-in", takesArgs: false, builtin: true },
    { name: "diff", description: "Toggle files changed in this session", source: "built-in", takesArgs: false, builtin: true },
    { name: "settings", description: "Open settings", source: "built-in", takesArgs: false, builtin: true },
    { name: "help", description: "Show all available commands", source: "built-in", takesArgs: false, builtin: true },
    { name: "exit", description: "Close OpenCode", source: "built-in", takesArgs: false, builtin: true },
  ];
  const reg: CmdEntry[] = [...commands]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      name: c.name,
      description: c.description ?? "",
      source: c.source ?? "command",
      takesArgs: (c.hints ?? []).some((h) => h.includes("ARGUMENTS")) || /\$ARGUMENTS/.test(c.template ?? ""),
    }));
  return [...builtins, ...reg];
}
