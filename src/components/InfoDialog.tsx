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
void Groups; // kept for external use / legacy — info tab now uses vc-row cards

const PillGroups = ({ data }: { data: Group[] }) => (
  <div className="vc-frame">
    {data.map(([g, rows]) => (
      <div key={g} className="vc-section">
        <div className="vc-section-head" style={{ cursor: "default" }}>
          <i className="fa-solid fa-keyboard" style={{ opacity: 0.6 }} />
          <span>{g}</span>
          <span className="vc-count">{rows.length}</span>
        </div>
        <div className="vc-list">
          {rows.map(([l, r]) => (
            <div key={l} className="vc-row hk static locked">
              <span className="kc-group" style={{ flexShrink: 0 }}>
                <KcCaps raw={l} />
              </span>
              <span className="hk-lock" data-tip="Not rebindable — fixed"><i className="fa-solid fa-lock" /></span>
              <span className="vc-desc">{r}</span>
              <span className="vc-badge" style={{ marginLeft: "auto" }}>fixed</span>
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
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
void EqualWrap; // kept for legacy — hotkeys now use keycaps + vc-frame

// keycap helpers — each physical key is its own cap with + between
function KcCaps({ raw, isOff }: { raw: string; isOff?: boolean }) {
  // handle multi-bind strings like "Ctrl+= · Ctrl+-" or "Ctrl+C / Ctrl+X"
  if (raw.includes("·")) {
    const parts = raw.split(/\s*·\s*/);
    return (
      <span className="kc-group">
        {parts.map((p, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {i > 0 && <span className="kc-sep">·</span>}
            <SingleCaps raw={p} isOff={isOff} />
          </span>
        ))}
      </span>
    );
  }
  if (raw.includes(" / ")) {
    const parts = raw.split(/\s*\/\s*/);
    return (
      <span className="kc-group">
        {parts.map((p, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {i > 0 && <span className="kc-sep">/</span>}
            <SingleCaps raw={p} isOff={isOff} />
          </span>
        ))}
      </span>
    );
  }
  return <SingleCaps raw={raw} isOff={isOff} />;
}
function SingleCaps({ raw, isOff }: { raw: string; isOff?: boolean }) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "—") return <span className={`kc${isOff ? " off" : ""}`}>—</span>;
  // handle " / + ↑↓ Tab Enter Esc" style with spaces + plus
  const hasPlusSpaced = trimmed.includes(" + ");
  const hasSpace = trimmed.includes(" ");
  if (hasPlusSpaced || (hasSpace && trimmed.includes("+") && trimmed.split(/\s+/).length > 2)) {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return (
      <span className="kc-group">
        {tokens.map((tok, i) => {
          if (tok === "+") return <span key={i} className="kc-plus">+</span>;
          // keep parentheses hint as faint text outside caps
          if (tok.startsWith("(")) return <span key={i} className="kc-hint">{tok}</span>;
          return <span key={i} className={`kc${isOff ? " off" : ""}`}>{tok}</span>;
        })}
      </span>
    );
  }
  if (hasSpace) {
    const m = trimmed.match(/^(.+?)\s+(\(.+\))$/);
    if (m) {
      const bindingPart = m[1];
      const hint = m[2];
      const parts = bindingPart.split("+").map((s) => s.trim()).filter(Boolean);
      return (
        <span className="kc-group">
          {parts.map((p, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
              {i > 0 && <span className="kc-plus">+</span>}
              <span className={`kc${isOff ? " off" : ""}`}>{p}</span>
            </span>
          ))}
          <span className="kc-hint" style={{ marginLeft: 6 }}>{hint}</span>
        </span>
      );
    }
    // e.g. "Esc ×2 (within 4s)" or "Ctrl+wheel"
    const firstSpace = trimmed.indexOf(" ");
    const first = trimmed.slice(0, firstSpace);
    const rest = trimmed.slice(firstSpace).trim();
    if (first.includes("+")) {
      const parts = first.split("+").map((s) => s.trim()).filter(Boolean);
      return (
        <span className="kc-group">
          {parts.map((p, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
              {i > 0 && <span className="kc-plus">+</span>}
              <span className={`kc${isOff ? " off" : ""}`}>{p}</span>
            </span>
          ))}
          <span className="kc-hint" style={{ marginLeft: 6 }}>{rest}</span>
        </span>
      );
    }
    return (
      <span className="kc-group">
        <span className={`kc${isOff ? " off" : ""}`}>{first}</span>
        <span className="kc-hint" style={{ marginLeft: 6 }}>{rest}</span>
      </span>
    );
  }
  const parts = trimmed.split("+").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return <span className={`kc${isOff ? " off" : ""}`}>{trimmed}</span>;
  return (
    <span className="kc-group">
      {parts.map((p, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
          {i > 0 && <span className="kc-plus">+</span>}
          <span className={`kc${isOff ? " off" : ""}`}>{p}</span>
        </span>
      ))}
    </span>
  );
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
  const [hkQ, setHkQ] = useState("");
  const [hkCollapsed, setHkCollapsed] = useState<Set<string>>(() => new Set());
  const hkNeedle = hkQ.trim().toLowerCase();
  const isHkFiltering = !!hkNeedle;
  const toggleHk = (k: string) =>
    setHkCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

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
      if (t?.closest?.(".kc-btn") || t?.closest?.(".hk-pill") || t?.closest?.(".kc")) return;
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

  const renderCoreGroup = (group: string, ids: HotkeyId[]) => {
    const needle = hkNeedle;
    const filteredIds = !needle
      ? ids
      : ids.filter((id) => {
          const meta = HOTKEY_META[id];
          const binding = effectiveHotkeys[id] ?? "";
          return `${group} ${meta.desc} ${binding}`.toLowerCase().includes(needle);
        });
    const staticCandidates: [string, string][] = group === "In the app" ? [["Ctrl+wheel", "zoom the UI in / out"], ...STATIC_APP_KEYS] : [];
    const filteredStatic = !needle
      ? staticCandidates
      : staticCandidates.filter(([l, r]) => `${l} ${r}`.toLowerCase().includes(needle));
    if (needle && filteredIds.length === 0 && filteredStatic.length === 0) return null;
    const isCollapsed = !isHkFiltering && hkCollapsed.has(group);
    const iconMap: Record<string, string> = { "In the app": "fa-window-maximize", Editor: "fa-code" };
    const groupIcon = iconMap[group] ?? "fa-keyboard";
    const totalInGroup = filteredIds.length + filteredStatic.length;
    return (
      <div key={group} className={`vc-section${isCollapsed ? " collapsed" : ""}`}>
        <button type="button" className="vc-section-head" onClick={() => toggleHk(group)} aria-expanded={!isCollapsed}>
          <i className="fa-solid fa-chevron-down vc-chevron" />
          <i className={`fa-solid ${groupIcon}`} />
          <span>{group}</span>
          <span className="vc-count">{totalInGroup}</span>
        </button>
        <div className="vc-list">
          {filteredIds.map((id) => {
            const meta = HOTKEY_META[id];
            const binding = effectiveHotkeys[id];
            const def = DEFAULT_HOTKEYS[id];
            const isRec = rec === id;
            const conflict = conflictFor(id);
            const isUnbound = !binding;
            const isChanged = binding !== def;
            return (
              <div key={id} className={`vc-row hk${isRec ? " rec" : ""}${conflict ? " conflict" : ""}`}>
                <button
                  type="button"
                  className={`kc-btn${isRec ? " rec" : ""}${isUnbound ? " off" : ""}${conflict ? " conflict" : ""}`}
                  onClick={() => setRec(isRec ? null : id)}
                  data-tip={isRec ? "Press a combo — Esc to clear" : "Click to rebind"}
                  aria-label={`Rebind ${meta.desc}`}
                >
                  {isRec ? (
                    <span className="kc-rec-text">press keys… Esc to clear</span>
                  ) : binding ? (
                    <KcCaps raw={binding} isOff={isUnbound} />
                  ) : (
                    <span className="kc off">—</span>
                  )}
                  {!isRec && isChanged && <span className="hk-dot" title={binding ? `Default: ${def}` : `Default: ${def} — currently unbound`} />}
                </button>
                <span className="hk-rebind-hint" data-tip="Click to rebind"><i className="fa-solid fa-pen" /></span>
                <span className="vc-desc">
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
          {filteredStatic.map(([l, r]) => (
            <div key={l} className="vc-row hk static locked">
              <span className="kc-group" style={{ flexShrink: 0 }}>
                <KcCaps raw={l} />
              </span>
              <span className="hk-lock" data-tip="Not rebindable — fixed"><i className="fa-solid fa-lock" /></span>
              <span className="vc-desc">{r}</span>
              <span className="vc-badge" style={{ marginLeft: "auto" }}>fixed</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // filtered plugin groups — keycap style, collapsable
  const pluginGroupsFiltered = (() => {
    const list = plugins?.filter((p) => p.ext?.hotkeys?.length && !p.disabled) ?? [];
    const filtered = !hkNeedle
      ? list
      : list.filter((p) => {
          const name = p.name.toLowerCase();
          return (
            name.includes(hkNeedle) ||
            (p.ext!.hotkeys ?? []).some((d) => `${d.label} ${d.description ?? ""} ${getPluginHotkeyBinding(phk ?? {}, p.id, d) ?? ""}`.toLowerCase().includes(hkNeedle))
          );
        });
    return filtered.map((p) => {
      const defs = p.ext!.hotkeys!;
      const filteredDefs = !hkNeedle
        ? defs
        : defs.filter((def) => {
            const binding = getPluginHotkeyBinding(phk ?? {}, p.id, def) ?? "";
            return `${def.label} ${def.description ?? ""} ${binding}`.toLowerCase().includes(hkNeedle);
          });
      if (hkNeedle && filteredDefs.length === 0) return null;
      const isCollapsed = !isHkFiltering && hkCollapsed.has(p.id);
      return (
        <div key={p.id} className={`vc-section${isCollapsed ? " collapsed" : ""}`}>
          <button type="button" className="vc-section-head" onClick={() => toggleHk(p.id)} aria-expanded={!isCollapsed}>
            <i className="fa-solid fa-chevron-down vc-chevron" />
            <i className="fa-solid fa-puzzle-piece" />
            <span>{p.name} — plugin</span>
            <span className="vc-count">{filteredDefs.length}</span>
          </button>
          <div className="vc-list">
            {filteredDefs.map((def) => {
              const k = pluginHotkeyKey(p.id, def.id);
              const binding = getPluginHotkeyBinding(phk ?? {}, p.id, def);
              const defNorm = def.default ? normalizeBinding(def.default) : null;
              const isRec = rec === k;
              const conflict = conflictFor(k);
              const isUnbound = !binding;
              const isChanged = binding !== defNorm;
              return (
                <div key={k} className={`vc-row hk${isRec ? " rec" : ""}${conflict ? " conflict" : ""}`}>
                  <button
                    type="button"
                    className={`kc-btn${isRec ? " rec" : ""}${isUnbound ? " off" : ""}${conflict ? " conflict" : ""}`}
                    onClick={() => setRec(isRec ? null : k)}
                    data-tip={isRec ? "Press a combo — Esc to clear" : "Click to rebind"}
                    aria-label={`Rebind ${def.label}`}
                  >
                    {isRec ? (
                      <span className="kc-rec-text">press keys… Esc to clear</span>
                    ) : binding ? (
                      <KcCaps raw={binding} isOff={isUnbound} />
                    ) : (
                      <span className="kc off">—</span>
                    )}
                    {!isRec && isChanged && <span className="hk-dot" title={binding ? `Default: ${defNorm ?? "—"}` : `Default: ${defNorm ?? "—"} — currently unbound`} />}
                  </button>
                  <span className="hk-rebind-hint" data-tip="Click to rebind"><i className="fa-solid fa-pen" /></span>
                  <span className="vc-desc">
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
        </div>
      );
    }).filter(Boolean) as React.ReactNode[];
  })();

  const systemFiltered = !hkNeedle ? SYSTEM_KEYS : SYSTEM_KEYS.filter(([l, r]) => `${l} ${r}`.toLowerCase().includes(hkNeedle));
  const composerFiltered = !hkNeedle ? COMPOSER_KEYS : COMPOSER_KEYS.filter(([l, r]) => `${l} ${r}`.toLowerCase().includes(hkNeedle));
  const hasSystem = systemFiltered.length > 0;
  const hasComposer = composerFiltered.length > 0;
  const coreVisibleCount = orderedGroups.reduce((n, [g, ids]) => {
    const rendered = renderCoreGroup(g, ids);
    return n + (rendered ? 1 : 0);
  }, 0);
  const anyVisible = hasSystem || hasComposer || coreVisibleCount > 0 || pluginGroupsFiltered.length > 0;

  return (
    <div>
      <div className="vc-tip">
        <i className="fa-solid fa-keyboard" />
        <span>
          <strong>Keycaps</strong> — each key is a cap, <strong>+</strong> between keys. Click a chord to rebind, <strong>Esc</strong> clears (unbound = disabled). <i className="fa-solid fa-lock" style={{ margin: "0 2px", fontSize: 9 }} /> = not rebindable (fixed). Conflicts are shown but not blocked.
        </span>
      </div>
      <div className="browse-search vc-search">
        <label className="model-search-wrap" style={{ cursor: "text" }}>
          <i className="fa-solid fa-magnifying-glass" />
          <input
            className="model-search"
            placeholder="Filter hotkeys…  e.g. sidebar, Ctrl+B, copy line"
            value={hkQ}
            onChange={(e) => setHkQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && hkQ) {
                e.stopPropagation();
                setHkQ("");
              }
            }}
          />
          {hkQ && (
            <button type="button" className="reset-btn" onClick={() => setHkQ("")} data-tip="Clear filter">
              <i className="fa-solid fa-xmark" />
            </button>
          )}
        </label>
      </div>
      {!anyVisible ? (
        <div className="vc-empty">No hotkeys match “{hkQ}”</div>
      ) : (
        <div className="vc-frame">
          {hasSystem && (
            <div className={`vc-section${!isHkFiltering && hkCollapsed.has("__system") ? " collapsed" : ""}`}>
              <button type="button" className="vc-section-head" onClick={() => toggleHk("__system")} aria-expanded={isHkFiltering || !hkCollapsed.has("__system")}>
                <i className="fa-solid fa-chevron-down vc-chevron" />
                <i className="fa-solid fa-globe" />
                <span>System-wide</span>
                <span className="vc-count">{systemFiltered.length}</span>
              </button>
              <div className="vc-list">
                {systemFiltered.map(([l, r]) => (
                  <div key={l} className="vc-row hk static locked">
                    <span className="kc-group" style={{ flexShrink: 0 }}>
                      <KcCaps raw={l} />
                    </span>
                    <span className="hk-lock" data-tip="Not rebindable — fixed"><i className="fa-solid fa-lock" /></span>
                    <span className="vc-desc">{r}</span>
                    <span className="vc-badge" style={{ marginLeft: "auto" }}>fixed</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {orderedGroups.map(([g, ids]) => renderCoreGroup(g, ids))}
          {pluginGroupsFiltered}
          {hasComposer && (
            <div className={`vc-section${!isHkFiltering && hkCollapsed.has("__composer") ? " collapsed" : ""}`}>
              <button type="button" className="vc-section-head" onClick={() => toggleHk("__composer")} aria-expanded={isHkFiltering || !hkCollapsed.has("__composer")}>
                <i className="fa-solid fa-chevron-down vc-chevron" />
                <i className="fa-solid fa-comment" />
                <span>Composer</span>
                <span className="vc-count">{composerFiltered.length}</span>
              </button>
              <div className="vc-list">
                {composerFiltered.map(([l, r]) => (
                  <div key={l} className="vc-row hk static locked">
                    <span className="kc-group" style={{ flexShrink: 0 }}>
                      <KcCaps raw={l} />
                    </span>
                    <span className="hk-lock" data-tip="Not rebindable — fixed"><i className="fa-solid fa-lock" /></span>
                    <span className="vc-desc">{r}</span>
                    <span className="vc-badge" style={{ marginLeft: "auto" }}>fixed</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
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
  const [infoQ, setInfoQ] = useState("");
  const [infoCollapsed, setInfoCollapsed] = useState<Set<string>>(() => new Set());
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
          <div className="vc-tip">
            <i className="fa-solid fa-circle-info" />
            <span>
              <strong>App & plugins</strong> — overview of what's installed, what's enabled, and docs contributed by plugins. Matches the style of <strong>Voice</strong> and <strong>Commands</strong>.
            </span>
          </div>
          <div className="browse-search vc-search">
            <label className="model-search-wrap" style={{ cursor: "text" }}>
              <i className="fa-solid fa-magnifying-glass" />
              <input
                className="model-search"
                placeholder="Filter info…  e.g. plugin name, doc, id"
                value={infoQ}
                onChange={(e) => setInfoQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && infoQ) {
                    e.stopPropagation();
                    setInfoQ("");
                  }
                }}
              />
              {infoQ && (
                <button type="button" className="reset-btn" onClick={() => setInfoQ("")} data-tip="Clear filter">
                  <i className="fa-solid fa-xmark" />
                </button>
              )}
            </label>
          </div>
          {(() => {
            const q = infoQ.trim().toLowerCase();
            const isFiltering = !!q;
            const toggleInfo = (key: string) =>
              setInfoCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            const docGroupsKeys = docGroups(pluginDocs, "keys") as Group[];
            const filteredDocs: Group[] = q
              ? docGroupsKeys
                  .map(([g, rows]): Group => [
                    g,
                    rows.filter(([l, r]) => `${l} ${r} ${g}`.toLowerCase().includes(q)),
                  ])
                  .filter(([, rows]) => rows.length > 0)
              : docGroupsKeys;
            const filteredPlugins = (plugins ?? []).filter((p) => {
              if (!q) return true;
              return `${p.name} ${p.id} ${p.dir} ${p.description ?? ""} ${p.version ?? ""}`.toLowerCase().includes(q);
            });
            const hasPlugins = (plugins ?? []).length > 0;
            const hasDocs = docGroupsKeys.length > 0;
            const hasAny = filteredPlugins.length > 0 || filteredDocs.length > 0;
            if (isFiltering && !hasAny) {
              return <div className="vc-empty">No matches for “{infoQ}”</div>;
            }
            if (!hasPlugins && !hasDocs) {
              return (
                <div className="vc-frame">
                  <div className="info-hero">
                    <i className="fa-solid fa-puzzle-piece" />
                    <div>
                      <div className="info-hero-title">No plugins installed</div>
                      <div className="info-hero-desc">
                        Plugins add voice phrases, slash commands, hotkeys and settings. Drop a folder with <strong>plugin.json</strong> + <strong>main.js</strong> into the plugins folder or browse the catalog.
                      </div>
                      <div className="info-stat-row">
                        <span className="info-stat"><i className="fa-solid fa-folder-open" /><strong>plugins</strong> folder</span>
                        <span className="info-stat"><i className="fa-solid fa-store" />Browse catalog</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div className="vc-frame">
                {/* overview hero — always visible */}
                <div className="info-hero">
                  <i className="fa-solid fa-layer-group" />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="info-hero-title">OpenCode GUI</div>
                    <div className="info-hero-desc">
                      Lightweight Tauri client for <strong>opencode</strong> — voice + slash + hotkeys, plugin host, glass UI. Data below is live from installed plugins.
                    </div>
                    <div className="info-stat-row">
                      <span className="info-stat"><i className="fa-solid fa-puzzle-piece" /><strong>{plugins?.length ?? 0}</strong> plugins</span>
                      <span className="info-stat"><i className="fa-solid fa-toggle-on" /><strong>{plugins?.filter((p) => !p.disabled).length ?? 0}</strong> enabled</span>
                      <span className="info-stat"><i className="fa-solid fa-book" /><strong>{filteredDocs.reduce((n, [, rows]) => n + rows.length, 0)}</strong> docs</span>
                    </div>
                  </div>
                </div>

                {/* installed plugins — collapsable */}
                {hasPlugins && (
                  <div className={`vc-section${!isFiltering && infoCollapsed.has("__plugins") ? " collapsed" : ""}`}>
                    <button type="button" className="vc-section-head" onClick={() => toggleInfo("__plugins")} aria-expanded={isFiltering || !infoCollapsed.has("__plugins")}>
                      <i className="fa-solid fa-chevron-down vc-chevron" />
                      <i className="fa-solid fa-puzzle-piece" />
                      <span>Installed plugins</span>
                      <span className="vc-count">{filteredPlugins.length}{q ? ` / ${plugins!.length}` : ""}</span>
                    </button>
                    <div className="vc-list">
                      {filteredPlugins.length === 0 ? (
                        <div className="vc-empty">No plugins match “{infoQ}”</div>
                      ) : (
                        filteredPlugins.map((p) => (
                          <div key={p.dir} className="vc-row" style={p.disabled ? { opacity: 0.72 } : undefined}>
                            <div className="vc-name">
                              {p.name}
                              {p.version && <span className="vc-badge accent">{p.version}</span>}
                              {p.disabled && <span className="vc-badge">disabled</span>}
                              {p.error && <span className="vc-badge danger">error</span>}
                            </div>
                            <div className="vc-desc">{p.description || "—"}</div>
                            {p.error && (
                              <div className="vc-ex" style={{ color: "var(--danger)" }}>
                                <i className="fa-solid fa-triangle-exclamation" />
                                <span>{p.error}</span>
                              </div>
                            )}
                            <div className="vc-ex">
                              <i className="fa-solid fa-fingerprint" />
                              <span>{p.id}{p.id !== p.dir ? ` · ${p.dir}` : ""}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* plugin-contributed docs — one collapsable section per plugin */}
                {filteredDocs.map(([g, rows]) => {
                  const isCollapsed = !isFiltering && infoCollapsed.has(g);
                  return (
                    <div key={g} className={`vc-section${isCollapsed ? " collapsed" : ""}`}>
                      <button type="button" className="vc-section-head" onClick={() => toggleInfo(g)} aria-expanded={!isCollapsed}>
                        <i className="fa-solid fa-chevron-down vc-chevron" />
                        <i className="fa-solid fa-puzzle-piece" />
                        <span>{g}</span>
                        <span className="vc-count">{rows.length}</span>
                      </button>
                      <div className="vc-list">
                        {rows.map(([l, r]) => (
                          <div key={l} className="vc-row">
                            <div className="vc-name">{l}</div>
                            <div className="vc-desc">{r || "—"}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <p className="cmd-note">Plugins live in <code>%USERPROFILE%\.config\.opencode-gui\plugins\</code> — toggle disables without deleting, delete removes the folder. Docs above come from each plugin's <code>info</code> export.</p>
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
            <>
              <div className="vc-tip">
                <i className="fa-solid fa-keyboard" />
                <span>
                  <strong>Keycaps</strong> — each key is a cap, <strong>+</strong> between keys. Reference only — connect settings to rebind.
                </span>
              </div>
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
