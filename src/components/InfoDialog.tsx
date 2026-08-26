import { useState } from "react";
import Dialog from "./Dialog";
import { CommandRows } from "./CommandDialog";
import type { CmdEntry } from "../hooks/useOpencode";
import "../styles/dialog.css";

type Row = [string, string]; // [mono left, dim right]
type Group = [string, Row[]];

// documentation rows contributed by plugins, grouped under their name
export type PluginDocs = { name: string; info: { voice?: Row[]; keys?: Row[] } }[];

const docGroups = (docs: PluginDocs | undefined, tab: "voice" | "keys"): Group[] =>
  (docs ?? []).flatMap(({ name, info }) => {
    const rows = info[tab];
    return rows?.length ? [[`${name} — plugin`, rows] as Group] : [];
  });

const VOICE: Group[] = [
  [
    "Sessions & UI",
    [
      ["new session", "start a fresh chat"],
      ["stop", "abort generation"],
      ["dark mode / light mode", "switch theme variant"],
      ["theme latte", "switch to a theme"],
      ["open settings / close settings", ""],
      ["toggle sidebar", ""],
      ["cycle agent", ""],
      ["send it", "send the draft"],
      ["clear prompt", "erase the composer"],
    ],
  ],
  [
    "Apps",
    [
      ["launch spotify", "or any installed app"],
      ["close chrome / quit chrome", ""],
      ["minimize calculator", ""],
      ["kill chrome", "force-close"],
    ],
  ],
  [
    "Dictation & speech",
    [
      ["prompt …", "fill the composer with the rest"],
      ["send …", "fill and send at once"],
      ["debrief", "summarize recent changes aloud"],
      ["be quiet / tais-toi", "stop speaking"],
      ["can you hear me", "mic check"],
      ["run compact", "execute a slash command"],
    ],
  ],
  [
    "Git",
    [
      ["git status", "show the git panel"],
      ["commit", "commit staged — generates a message if none typed"],
      ["push / pull", ""],
      ["stage all", ""],
    ],
  ],
];

const KEYS: Group[] = [
  [
    "System-wide",
    [
      ["Alt+Space", "show/hide the window from anywhere"],
      ["Ctrl+Shift+M", "mic toggle from anywhere"],
    ],
  ],
  [
    "In the app",
    [
      ["Ctrl+B", "toggle sidebar"],
      ["Ctrl+M", "mic on/off"],
      ["Ctrl+P", "pin window on top"],
      ["Ctrl+wheel", "zoom the UI in / out"],
      ["Ctrl+= · Ctrl+-", "zoom in · out"],
      ["Ctrl+0", "reset zoom"],
      ["Tab", "cycle agent"],
      ["Esc ×2 (within 4s)", "stop generation — a first Esc arms it, menus eat theirs"],
      ["Escape", "close menus and dialogs"],
    ],
  ],
  [
    "Composer",
    [
      ["/ + ↑↓ Tab Enter Esc", "slash-command autocomplete"],
      ["↑↓ · Home/End", "navigate the model menu"],
    ],
  ],
];

const Groups = ({ data }: { data: Group[] }) => (
  <>
    {data.map(([g, rows]) => (
      <div key={g} className="cmd-group">
        <div className="cmd-group-label">{g}</div>
        {rows.map(([l, r]) => (
          <div key={l} className="cmd-row">
            <span className="mono cmd-name">{l}</span>
            <span className="cmd-desc">{r}</span>
          </div>
        ))}
      </div>
    ))}
  </>
);

// opened from Settings › (i) — voice phrases, slash commands, hotkeys
export default function InfoDialog({
  commands,
  pluginDocs,
  onClose,
}: {
  commands: CmdEntry[];
  pluginDocs?: PluginDocs;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"voice" | "cmds" | "keys">("voice");
  return (
    <Dialog title="Info" onClose={onClose} top wide>
      <div className="dlg-tabs">
        {(
          [
            ["voice", "Voice commands"],
            ["cmds", "Commands"],
            ["keys", "Hotkeys"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={`dlg-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "voice" && (
        <>
          <Groups data={[...VOICE, ...docGroups(pluginDocs, "voice")]} />
          <p className="cmd-note">
            Phrasing works in any language whisper understands — an unmatched
            utterance gets a second, translating pass (Settings › Voice).
            Politeness words are ignored and one-letter typos in command words
            are forgiven. Start with "prompt" to fill the composer or "send" to
            fill and send; a command buried mid-sentence is read back and waits
            for a yes.
          </p>
        </>
      )}
      {tab === "cmds" && <CommandRows commands={commands} />}
      {tab === "keys" && (
        <>
          <Groups data={[...KEYS, ...docGroups(pluginDocs, "keys")]} />
          <p className="cmd-note">Zoom shortcuts scale the whole interface (same presets as Settings) — WebView2's own page zoom stays disabled.</p>
        </>
      )}
    </Dialog>
  );
}
