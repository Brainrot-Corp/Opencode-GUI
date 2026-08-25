import { useState } from "react";
import Dialog from "./Dialog";
import { CommandRows } from "./CommandDialog";
import type { CmdEntry } from "../hooks/useOpencode";
import "../styles/dialog.css";

type Row = [string, string]; // [mono left, dim right]
type Group = [string, Row[]];

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
    "Lights — set up in Settings › Lights",
    [
      ["lights on / lights off", ""],
      ["turn the desk lamp off", ""],
      ["dim the lights to fifty percent", ""],
      ["set it to 75 percent", ""],
      ["make it warm white / cool white", ""],
      ["turn it red / blue / green…", ""],
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
      ["Ctrl+M", "mic on/off"],
      ["Ctrl+P", "pin window on top"],
      ["Tab", "cycle agent"],
      ["Enter · Shift+Enter", "send · newline"],
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
  onClose,
}: {
  commands: CmdEntry[];
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
          <Groups data={VOICE} />
          <p className="cmd-note">
            English, French &amp; Spanish phrasing all work, politeness words are ignored, and
            one-letter typos in device/color words are forgiven. Start with "prompt" to fill the
            composer or "send" to fill and send; a command buried mid-sentence is read back and
            waits for a yes.
          </p>
        </>
      )}
      {tab === "cmds" && <CommandRows commands={commands} />}
      {tab === "keys" && (
        <>
          <Groups data={KEYS} />
          <p className="cmd-note">Ctrl+=/-/0 and Ctrl+wheel are blocked — UI scale lives in Settings.</p>
        </>
      )}
    </Dialog>
  );
}
