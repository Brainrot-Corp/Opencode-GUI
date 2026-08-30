import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
      ["stop", "abort the current generation"],
      ["dark mode / light mode", "switch theme variant"],
      ["theme latte", "switch to any theme by name"],
      ["open settings / close settings", "show or hide the settings drawer"],
      ["toggle sidebar", "show or hide the session sidebar"],
      ["cycle agent", "rotate to the next agent (like Tab)"],
      ["send it", "send the draft in the composer"],
      ["clear prompt", "erase the composer"],
    ],
  ],
  [
    "Apps",
    [
      ["launch spotify", "open any installed app by name"],
      ["close chrome / quit chrome", "close an app by name"],
      ["minimize calculator", "minimize an app by name"],
      ["kill chrome", "force-close an app"],
    ],
  ],
  [
    "Dictation & speech",
    [
      ["prompt …", "fill the composer — keep speaking after prompt"],
      ["send …", "fill and send immediately"],
      ["debrief", "speak a summary of recent changes"],
      ["be quiet / tais-toi", "stop speaking immediately"],
      ["can you hear me", "mic check — confirms listening"],
      ["run compact", "execute any slash command by voice"],
    ],
  ],
  [
    "Git",
    [
      ["git status", "show the git panel"],
      ["commit", "commit staged changes (auto-generates a message)"],
      ["push / pull", "push or pull the current branch"],
      ["stage all", "stage all changes"],
    ],
  ],
];

const VOICE_ICONS: Record<string, string> = {
  "Sessions & UI": "fa-clone",
  Apps: "fa-rocket",
  "Dictation & speech": "fa-microphone",
  Git: "fa-code-branch",
};

const VOICE_EXAMPLES: Record<string, string> = {
  "new session": "“new session”",
  stop: "“stop”",
  "dark mode / light mode": "“dark mode” or “light mode”",
  "theme latte": "“theme nightfall” — any installed theme",
  "open settings / close settings": "“open settings”",
  "toggle sidebar": "“toggle sidebar”",
  "cycle agent": "“cycle agent”",
  "send it": "“send it”",
  "clear prompt": "“clear prompt”",
  "launch spotify": "“launch Spotify” — any app name works",
  "close chrome / quit chrome": "“close Chrome” or “quit Chrome”",
  "minimize calculator": "“minimize Calculator”",
  "kill chrome": "“kill Chrome” — force-close",
  "prompt …": "“prompt fix the header padding on mobile”",
  "send …": "“send hello team, draft is ready”",
  debrief: "“debrief”",
  "be quiet / tais-toi": "“be quiet” or “tais-toi”",
  "can you hear me": "“can you hear me?”",
  "run compact": "“run compact” — any /command works",
  "git status": "“git status”",
  commit: "“commit”",
  "push / pull": "“push” or “pull”",
  "stage all": "“stage all”",
};

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

const PillGroups = ({ data, left }: { data: Group[]; left?: boolean }) => (
  <>
    {data.map(([g, rows]) => (
      <div key={g} className={`cmd-group cmd-group--pills${left ? " left" : ""}`}>
        <div className="cmd-group-label">{g}</div>
        {rows.map(([l, r]) => (
          <div key={l} className="cmd-row hk-row static">
            <span className={`mono cmd-name hk-pill fixed${left ? " left" : ""}`}>{l}</span>
            <span className="cmd-desc">{r}</span>
          </div>
        ))}
      </div>
    ))}
  </>
);

// richer voice rendering — icon header, accent command text (no pill), description + example line, collapsable groups
function VoiceList({ data, filter }: { data: Group[]; filter: string }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const q = filter.trim().toLowerCase();
  const isFiltering = !!q;
  const filtered = q
    ? data
        .map(([g, rows]): Group => [
          g,
          rows.filter(([l, r]) => {
            const ex = VOICE_EXAMPLES[l] ?? "";
            return `${l} ${r} ${ex} ${g}`.toLowerCase().includes(q);
          }),
        ])
        .filter(([, rows]) => rows.length > 0)
    : data;

  if (!filtered.length) {
    return <div className="vc-empty">No matches for “{filter}”</div>;
  }

  const toggle = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <div className="vc-frame">
      {filtered.map(([g, rows]) => {
        const icon = VOICE_ICONS[g] ?? "fa-puzzle-piece";
        const isPlugin = g.endsWith("— plugin");
        const headIcon = isPlugin ? "fa-puzzle-piece" : icon;
        const isCollapsed = !isFiltering && collapsed.has(g);
        return (
          <div key={g} className={`vc-section${isCollapsed ? " collapsed" : ""}`}>
            <button type="button" className="vc-section-head" onClick={() => toggle(g)} aria-expanded={!isCollapsed}>
              <i className="fa-solid fa-chevron-down vc-chevron" />
              <i className={`fa-solid ${headIcon}`} />
              <span>{g}</span>
              <span className="vc-count">{rows.length}</span>
            </button>
            <div className="vc-list">
              {rows.map(([l, r]) => {
                const variants = l.split(/\s*\/\s*/);
                const ex = VOICE_EXAMPLES[l] ?? (isPlugin ? `“${variants[0]}”` : "");
                return (
                  <div key={l} className="vc-row">
                    <div className="vc-name">
                      {variants.map((v, i) => (
                        <span key={v}>
                          {i > 0 && <span className="vc-or">or</span>}
                          <span>{v}</span>
                        </span>
                      ))}
                    </div>
                    <div className="vc-desc">{r || (isPlugin ? "plugin command" : "—")}</div>
                    {ex && (
                      <div className="vc-ex">
                        <i className="fa-solid fa-quote-left" />
                        <span>{ex}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function useEqualPills(deps: React.DependencyList) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      const pills = Array.from(root.querySelectorAll<HTMLElement>(".hk-pill"));
      if (!pills.length) return;
      pills.forEach((p) => (p.style.width = ""));
      let max = 0;
      pills.forEach((p) => { max = Math.max(max, p.offsetWidth); });
      max = Math.min(max, 220);
      if (max > 0) pills.forEach((p) => (p.style.width = `${max}px`));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(root);
    // watch for pills added/removed (plugin on/off) without size change
    const mo = new MutationObserver(update);
    mo.observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    (document as any).fonts?.ready?.then?.(update);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", update);
    };
  }, deps);
  return ref;
}

function EqualWrap({ children, deps }: { children: React.ReactNode; deps?: React.DependencyList }) {
  const ref = useEqualPills(deps ?? []);
  return <div ref={ref}>{children}</div>;
}

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
    <div key={group} className="cmd-group cmd-group--pills">
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

  const equalRef = useEqualPills([rec, JSON.stringify(effectiveHotkeys), JSON.stringify(phk), JSON.stringify(plugins?.map((p) => [p.id, p.disabled, p.ext?.hotkeys])), allUnchanged]);

  const pluginGroups =
    plugins
      ?.filter((p) => p.ext?.hotkeys?.length && !p.disabled)
      .map((p) => {
        const defs = p.ext!.hotkeys!;
        return (
          <div key={p.id} className="cmd-group cmd-group--pills">
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
    <div ref={equalRef}>
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
    </div>
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
  const [voiceQ, setVoiceQ] = useState("");
  const voiceData = [...VOICE, ...docGroups(pluginDocs, "voice")] as Group[];
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
          <div className="vc-tip">
            <i className="fa-solid fa-circle-info" />
            <span>
              <strong>Any language Whisper understands</strong> — unmatched speech gets a translating pass. Polite words are ignored, one-letter typos are forgiven. Say <strong>prompt …</strong> to fill the composer or <strong>send …</strong> to fill + send.
              A command buried mid-sentence is read back and waits for “yes”.
            </span>
          </div>
          <div className="browse-search vc-search">
            <label className="model-search-wrap" style={{ cursor: "text" }}>
              <i className="fa-solid fa-magnifying-glass" />
              <input
                className="model-search"
                placeholder="Filter voice commands…"
                value={voiceQ}
                onChange={(e) => setVoiceQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && voiceQ) {
                    e.stopPropagation();
                    setVoiceQ("");
                  }
                }}
              />
              {voiceQ && (
                <button type="button" className="reset-btn" onClick={() => setVoiceQ("")} data-tip="Clear filter">
                  <i className="fa-solid fa-xmark" />
                </button>
              )}
            </label>
          </div>
          <VoiceList data={voiceData} filter={voiceQ} />
          <p className="cmd-note">
            {voiceQ ? `${voiceData.reduce((n, [, rows]) => n + rows.filter(([l, r]) => `${l} ${r} ${(VOICE_EXAMPLES[l] ?? "")}`.toLowerCase().includes(voiceQ.toLowerCase())).length, 0)} shown — clear the filter to see all.` : "Tip: phrasing is forgiving — “please launch spotify” and “lunch spotify” both work."}
          </p>
        </>
      )}
      {tab === "cmds" && <CommandRows commands={commands} />}
      {tab === "keys" && (
        <>
          {settings && update ? (
            <HotkeysTab settings={settings} update={update} plugins={plugins} />
          ) : (
            <EqualWrap deps={[tab]}>
              <PillGroups
                data={[
                  ["System-wide", SYSTEM_KEYS],
                  ["In the app", ORIGINAL_APP_KEYS],
                  ["Composer", COMPOSER_KEYS],
                  ["Editor — File Editor & Notepad", EDITOR_KEYS],
                ]}
              />
              <p className="cmd-note">Zoom shortcuts scale the whole interface (same presets as Settings) — WebView2's own page zoom stays disabled.</p>
            </EqualWrap>
          )}
        </>
      )}
    </Dialog>
  );
}
