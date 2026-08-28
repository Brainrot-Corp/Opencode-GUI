import { useEffect, useState } from "react";
import Dialog from "./Dialog";
import { CommandRows } from "./CommandDialog";
import type { CmdEntry } from "../hooks/useOpencode";
import type { AppSettings } from "../hooks/useSettings";
import { DEFAULT_HOTKEYS, formatEvent, HOTKEY_ORDER, HOTKEY_META, type HotkeyId } from "../lib/hotkeys";
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

// static non-rebindable rows — kept exactly as before for non-rebindable display
const SYSTEM_KEYS: Row[] = [
  ["Alt+Space", "show/hide the window from anywhere"],
  ["Ctrl+Shift+M", "mic toggle from anywhere"],
];

const STATIC_APP_KEYS: Row[] = [
  ["Esc ×2 (within 4s)", "stop generation — a first Esc arms it, menus eat theirs"],
  ["Escape", "close menus and dialogs"],
];

// original "In the app" rows as they were before rebind (fallback / reference)
const ORIGINAL_APP_KEYS: Row[] = [
  ["Ctrl+B", "toggle sidebar"],
  ["Ctrl+M", "mic on/off"],
  ["Ctrl+O", "open workspace"],
  ["Ctrl+Shift+N", "open new window"],
  ["Ctrl+P", "pin window on top"],
  ["Ctrl+wheel", "zoom the UI in / out"],
  ["Ctrl+= · Ctrl+-", "zoom in · out"],
  ["Ctrl+0", "reset zoom"],
  ["Tab", "cycle agent"],
  ["Esc ×2 (within 4s)", "stop generation — a first Esc arms it, menus eat theirs"],
  ["Escape", "close menus and dialogs"],
];

const COMPOSER_KEYS: Row[] = [
  ["/ + ↑↓ Tab Enter Esc", "slash-command autocomplete"],
  ["↑↓ · Home/End", "navigate the model menu"],
  ["Ctrl+C / Ctrl+X (no selection)", "copy / cut current line (Enter still sends)"],
];

const EDITOR_KEYS: Row[] = [
  ["Ctrl+C / Ctrl+X (no selection)", "copy / cut current line"],
  ["Ctrl+Shift+K", "delete line"],
  ["Alt+↑ / Alt+↓", "move line up / down"],
  ["Shift+Alt+↑ / Shift+Alt+↓", "duplicate line up / down"],
  ["Ctrl+/", "toggle line comment (per file type: //, #, <!-- -->, /* */)"],
  ["Ctrl+L", "select line"],
  ["Ctrl+Enter / Ctrl+Shift+Enter", "insert line below / above"],
  ["Tab", "indent (File Editor & Notepad) — 2 spaces"],
  ["Ctrl+S / Ctrl+F", "save / find (File Editor)"],
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

function HotkeysTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const [rec, setRec] = useState<HotkeyId | null>(null);

  // capture next key while recording
  useEffect(() => {
    if (!rec) return;
    const onDown = (e: KeyboardEvent) => {
      // Escape alone => unbind
      if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        update({ hotkeys: { ...settings.hotkeys, [rec]: null } });
        setRec(null);
        return;
      }
      // ignore pure modifiers, repeat, and Escape already handled
      if (e.repeat) return;
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const binding = formatEvent(e);
      if (!binding) return;
      // allow binding but detect conflict visually — we still assign and show warning
      e.preventDefault();
      e.stopPropagation();
      update({ hotkeys: { ...settings.hotkeys, [rec]: binding } });
      setRec(null);
    };
    // mousedown outside cancels
    const onMouse = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".hk-pill")) return;
      setRec(null);
    };
    window.addEventListener("keydown", onDown, { capture: true } as any);
    window.addEventListener("mousedown", onMouse, true);
    return () => {
      window.removeEventListener("keydown", onDown, { capture: true } as any);
      window.removeEventListener("mousedown", onMouse, true);
    };
  }, [rec, settings.hotkeys, update]);

  const conflictFor = (id: HotkeyId): string | null => {
    const cur = settings.hotkeys[id];
    if (!cur) return null;
    for (const other of HOTKEY_ORDER) {
      if (other === id) continue;
      if (settings.hotkeys[other] === cur) return other;
    }
    return null;
  };

  const allUnchanged = HOTKEY_ORDER.every((id) => settings.hotkeys[id] === DEFAULT_HOTKEYS[id]);

  return (
    <>
      {/* System-wide — rendered exactly as before (non-rebindable) */}
      <Groups data={[["System-wide", SYSTEM_KEYS]]} />

      {/* In the app — rebindable pills + remaining static rows kept as before */}
      <div className="cmd-group">
        <div className="cmd-group-label">In the app</div>
        {HOTKEY_ORDER.map((id) => {
          const meta = HOTKEY_META[id];
          const binding = settings.hotkeys[id];
          const def = DEFAULT_HOTKEYS[id];
          const isRec = rec === id;
          const conflict = conflictFor(id);
          const isUnbound = !binding;
          const isChanged = binding !== def;
          const display = isRec ? "press keys… Esc to clear" : binding ?? "—";
          return (
            <div key={id} className={`cmd-row hk-row${isRec ? " rec" : ""}${isUnbound ? " unbound" : ""}${conflict ? " conflict" : ""}`}>
              <button
                type="button"
                className={`mono cmd-name hk-pill${isRec ? " rec" : ""}${isUnbound ? " off" : ""}`}
                onClick={() => setRec(isRec ? null : id)}
                data-tip={isRec ? "Press a combo — Esc to clear" : "Click to rebind"}
                aria-label={`Rebind ${meta.desc}`}
              >
                <span className="hk-key">{display}</span>
                {!isRec && isChanged && <span className="hk-dot" title={binding ? `Default: ${def}` : `Default: ${def} — currently unbound`} />}
              </button>
              <span className="cmd-desc hk-desc">
                {meta.desc}
                {conflict && <span className="hk-warn" title={`Same as ${conflict}`}> · conflicts with {conflict}</span>}
              </span>
              {isChanged && !isRec && (
                <button type="button" className="hk-reset" onClick={() => update({ hotkeys: { ...settings.hotkeys, [id]: def } })} data-tip={`Reset to ${def}`}>
                  <i className="fa-solid fa-rotate-left" />
                </button>
              )}
            </div>
          );
        })}
        {/* static rows of this group — kept exactly as before */}
        <div className="cmd-row">
          <span className="mono cmd-name">Ctrl+wheel</span>
          <span className="cmd-desc">zoom the UI in / out</span>
        </div>
        {STATIC_APP_KEYS.map(([l, r]) => (
          <div key={l} className="cmd-row">
            <span className="mono cmd-name">{l}</span>
            <span className="cmd-desc">{r}</span>
          </div>
        ))}
      </div>

      {!allUnchanged && (
        <div className="hk-actions">
          <button type="button" className="reset-btn" onClick={() => update({ hotkeys: { ...DEFAULT_HOTKEYS } })}>
            <i className="fa-solid fa-rotate-left" /> Reset all
          </button>
        </div>
      )}

      <Groups data={[["Composer", COMPOSER_KEYS], ["Editor — File Editor & Notepad", EDITOR_KEYS]]} />
      <p className="cmd-note">Click a binding in “In the app” to record a new combo — Esc clears it (unbound = disabled). Zoom shortcuts scale the whole interface; WebView2's own page zoom stays disabled.</p>
    </>
  );
}

// opened from Settings › (i) — voice phrases, slash commands, hotkeys
export default function InfoDialog({
  commands,
  pluginDocs,
  settings,
  update,
  onClose,
}: {
  commands: CmdEntry[];
  pluginDocs?: PluginDocs;
  onClose: () => void;
  settings?: AppSettings;
  update?: (patch: Partial<AppSettings>) => void;
}) {
  const [tab, setTab] = useState<"voice" | "cmds" | "keys">("keys");
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
          {settings && update ? (
            <HotkeysTab settings={settings} update={update} />
          ) : (
            <>
              <Groups
                data={[
                  ["System-wide", SYSTEM_KEYS],
                  ["In the app", ORIGINAL_APP_KEYS],
                  ["Composer", COMPOSER_KEYS],
                  ["Editor — File Editor & Notepad", EDITOR_KEYS],
                ]}
              />
              <p className="cmd-note">Zoom shortcuts scale the whole interface (same presets as Settings) — WebView2's own page zoom stays disabled.</p>
            </>
          )}
          {pluginDocs && docGroups(pluginDocs, "keys").length > 0 && <Groups data={docGroups(pluginDocs, "keys")} />}
        </>
      )}
    </Dialog>
  );
}
