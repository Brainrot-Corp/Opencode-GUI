import { useEffect, useState } from "react";
import Dialog from "./Dialog";
import { CommandRows } from "./CommandDialog";
import type { CmdEntry } from "../hooks/useOpencode";
import type { AppSettings } from "../hooks/useSettings";
import {
  DEFAULT_HOTKEYS,
  formatEvent,
  HOTKEY_ORDER,
  HOTKEY_META,
  type HotkeyId,
  normalizeBinding,
  getPluginHotkeyBinding,
  pluginHotkeyKey,
} from "../lib/hotkeys";
import type { LoadedPlugin } from "../lib/plugins";
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

const PillGroups = ({ data }: { data: Group[] }) => (
  <>
    {data.map(([g, rows]) => (
      <div key={g} className="cmd-group">
        <div className="cmd-group-label">{g}</div>
        {rows.map(([l, r]) => (
          <div key={l} className="cmd-row hk-row static">
            <span className="mono cmd-name hk-pill fixed">{l}</span>
            <span className="cmd-desc">{r}</span>
          </div>
        ))}
      </div>
    ))}
  </>
);

export function HotkeysTab({
  settings,
  update,
  plugins,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
  plugins?: LoadedPlugin[];
}) {
  const [rec, setRec] = useState<string | null>(null);

  // capture next key while recording (core or plugin)
  useEffect(() => {
    if (!rec) return;
    const isPlugin = rec.includes(":");
    const onDown = (e: KeyboardEvent) => {
      // Escape alone => unbind
      if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isPlugin) {
          update({ pluginHotkeys: { ...((settings as any).pluginHotkeys ?? {}), [rec]: null } });
        } else {
          update({ hotkeys: { ...(settings.hotkeys ?? {}), [rec as HotkeyId]: null } });
        }
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
      if (isPlugin) {
        update({ pluginHotkeys: { ...((settings as any).pluginHotkeys ?? {}), [rec]: binding } });
      } else {
        update({ hotkeys: { ...(settings.hotkeys ?? {}), [rec as HotkeyId]: binding } });
      }
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
  }, [rec, (settings as any).hotkeys, (settings as any).pluginHotkeys, update]);

  const hk = (settings as any).hotkeys as Record<string, string | null> | undefined;
  const phk = (settings as any).pluginHotkeys as Record<string, string | null> | undefined;
  const effectiveHotkeys: Record<string, string | null> = {};
  for (const id of HOTKEY_ORDER) {
    (effectiveHotkeys as any)[id] = hk && id in hk ? hk[id] : DEFAULT_HOTKEYS[id as HotkeyId];
  }

  // collect all effective bindings (core + plugins) for conflict detection
  const allEffective = (() => {
    const m = new Map<string, string>();
    const phkLocal = phk ?? {};
    for (const id of HOTKEY_ORDER) {
      const eff = effectiveHotkeys[id];
      if (eff) m.set(id, eff);
    }
    if (plugins) {
      for (const p of plugins) {
        if (p.disabled || !p.ext?.hotkeys?.length) continue;
        for (const def of p.ext.hotkeys) {
          const k = pluginHotkeyKey(p.id, def.id);
          const v = getPluginHotkeyBinding(phkLocal, p.id, def);
          if (v) m.set(k, v);
        }
      }
    }
    return m;
  })();

  const conflictFor = (key: string): string | null => {
    const cur = allEffective.get(key);
    if (!cur) return null;
    for (const [other, val] of allEffective) {
      if (other === key) continue;
      if (val === cur) return other;
    }
    return null;
  };

  const coreUnchanged = HOTKEY_ORDER.every((id) => effectiveHotkeys[id] === DEFAULT_HOTKEYS[id as HotkeyId]);
  const pluginUnchanged = (() => {
    if (!plugins) return true;
    for (const p of plugins) {
      if (!p.ext?.hotkeys?.length) continue;
      for (const def of p.ext.hotkeys) {
        const eff = getPluginHotkeyBinding(phk ?? {}, p.id, def);
        const defNorm = def.default ? normalizeBinding(def.default) : null;
        if (eff !== defNorm) return false;
      }
    }
    // also check for stray overrides that no longer correspond to a plugin (orphans) — treat as changed
    if (plugins && phk && Object.keys(phk).length) {
      const validKeys = new Set(
        plugins.flatMap((p) => (p.ext?.hotkeys ?? []).map((d) => pluginHotkeyKey(p.id, d.id))),
      );
      for (const k of Object.keys(phk)) {
        if (!validKeys.has(k)) return false;
      }
    }
    return true;
  })();
  const allUnchanged = coreUnchanged && pluginUnchanged;

  // group core order by meta.group preserving order
  const orderedGroups = (() => {
    const map = new Map<string, HotkeyId[]>();
    const order: string[] = [];
    for (const id of HOTKEY_ORDER) {
      const g = HOTKEY_META[id].group;
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(id);
    }
    return order.map((g) => [g, map.get(g)!] as const);
  })();

  const renderCoreGroup = (group: string, ids: HotkeyId[]) => (
    <div key={group} className="cmd-group">
      <div className="cmd-group-label">{group}</div>
      {ids.map((id) => {
        const meta = HOTKEY_META[id];
        const binding = effectiveHotkeys[id];
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
              <button type="button" className="hk-reset" onClick={() => update({ hotkeys: { ...((settings.hotkeys ?? {}) as any), [id]: def } })} data-tip={`Reset to ${def}`}>
                <i className="fa-solid fa-rotate-left" />
              </button>
            )}
          </div>
        );
      })}
      {group === "In the app" && (
        <>
          <div className="cmd-row hk-row static">
            <span className="mono cmd-name hk-pill fixed">Ctrl+wheel</span>
            <span className="cmd-desc">zoom the UI in / out</span>
          </div>
          {STATIC_APP_KEYS.map(([l, r]) => (
            <div key={l} className="cmd-row hk-row static">
              <span className="mono cmd-name hk-pill fixed">{l}</span>
              <span className="cmd-desc">{r}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );

  const pluginGroups =
    plugins
      ?.filter((p) => p.ext?.hotkeys?.length && !p.disabled)
      .map((p) => {
        const defs = p.ext!.hotkeys!;
        return (
          <div key={p.id} className="cmd-group">
            <div className="cmd-group-label">{p.name} — plugin</div>
            {defs.map((def) => {
              const k = pluginHotkeyKey(p.id, def.id);
              const binding = getPluginHotkeyBinding(phk ?? {}, p.id, def);
              const defNorm = def.default ? normalizeBinding(def.default) : null;
              const isRec = rec === k;
              const conflict = conflictFor(k);
              const isUnbound = !binding;
              const isChanged = binding !== defNorm;
              const display = isRec ? "press keys… Esc to clear" : binding ?? "—";
              return (
                <div key={k} className={`cmd-row hk-row${isRec ? " rec" : ""}${isUnbound ? " unbound" : ""}${conflict ? " conflict" : ""}`}>
                  <button
                    type="button"
                    className={`mono cmd-name hk-pill${isRec ? " rec" : ""}${isUnbound ? " off" : ""}`}
                    onClick={() => setRec(isRec ? null : k)}
                    data-tip={isRec ? "Press a combo — Esc to clear" : "Click to rebind"}
                    aria-label={`Rebind ${def.label}`}
                  >
                    <span className="hk-key">{display}</span>
                    {!isRec && isChanged && <span className="hk-dot" title={binding ? `Default: ${defNorm ?? "—"}` : `Default: ${defNorm ?? "—"} — currently unbound`} />}
                  </button>
                  <span className="cmd-desc hk-desc">
                    {def.label}
                    {def.description ? ` — ${def.description}` : ""}
                    {conflict && <span className="hk-warn" title={`Same as ${conflict}`}> · conflicts with {conflict}</span>}
                  </span>
                  {isChanged && !isRec && (
                    <button
                      type="button"
                      className="hk-reset"
                      onClick={() => {
                        const next = { ...(phk ?? {}) };
                        delete next[k];
                        update({ pluginHotkeys: next });
                      }}
                      data-tip={`Reset to ${defNorm ?? "—"}`}
                    >
                      <i className="fa-solid fa-rotate-left" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      }) ?? null;

  return (
    <>
      {/* System-wide — non-rebindable but pill-styled */}
      <PillGroups data={[["System-wide", SYSTEM_KEYS]]} />

      {/* Core hotkeys grouped */}
      {orderedGroups.map(([g, ids]) => renderCoreGroup(g, ids))}

      {/* Plugin hotkeys (rebindable) */}
      {pluginGroups}

      {!allUnchanged && (
        <div className="hk-actions">
          <button
            type="button"
            className="reset-btn"
            onClick={() => update({ hotkeys: { ...DEFAULT_HOTKEYS }, pluginHotkeys: {} })}
          >
            <i className="fa-solid fa-rotate-left" /> Reset all
          </button>
        </div>
      )}

      {/* Composer — non-rebindable reference, same pill material */}
      <PillGroups data={[["Composer", COMPOSER_KEYS]]} />
      {/* Legacy editor static kept for reference when no core settings? now pills cover editor so keep minimal note */}
      <p className="cmd-note">Click a binding to record a new combo — Esc clears it (unbound = disabled). Conflicts are shown but not blocked. Zoom shortcuts scale the whole interface; WebView2's own page zoom stays disabled.</p>
    </>
  );
}

// opened from Settings › (i) — voice phrases, slash commands, hotkeys
export default function InfoDialog({
  commands,
  pluginDocs,
  plugins,
  settings,
  update,
  onClose,
}: {
  commands: CmdEntry[];
  pluginDocs?: PluginDocs;
  plugins?: LoadedPlugin[];
  onClose: () => void;
  settings?: AppSettings;
  update?: (patch: Partial<AppSettings>) => void;
}) {
  const [tab, setTab] = useState<"info" | "voice" | "cmds" | "keys">("info");
  return (
    <Dialog title="Info" onClose={onClose} top wide>
      <div className="dlg-tabs">
        {(
          [
            ["info", "Info"],
            ["voice", "Voice commands"],
            ["cmds", "Commands"],
            ["keys", "Hotkeys"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={`dlg-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id as any)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "info" && (
        <>
          {pluginDocs && docGroups(pluginDocs, "keys").length > 0 ? (
            <Groups data={docGroups(pluginDocs, "keys")} />
          ) : (
            <p className="cmd-note">No plugins installed — plugin hotkeys and slash docs will appear here.</p>
          )}
        </>
      )}
      {tab === "voice" && (
        <>
          <PillGroups data={[...VOICE, ...docGroups(pluginDocs, "voice")]} />
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
            <HotkeysTab settings={settings} update={update} plugins={plugins} />
          ) : (
            <>
              <PillGroups
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
        </>
      )}
    </Dialog>
  );
}
