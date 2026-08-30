import { useEffect, useRef, useState } from "react";
import Dialog from "./Dialog";
import type { CmdEntry } from "../hooks/useOpencode";

const CMD_GROUP_META: Record<string, { label: string; icon: string }> = {
  "built-in": { label: "Built-in", icon: "fa-star" },
  skill: { label: "Skills", icon: "fa-wand-magic-sparkles" },
  command: { label: "Custom", icon: "fa-terminal" },
  plugin: { label: "Plugins", icon: "fa-puzzle-piece" },
};
function cmdGroupMeta(key: string) {
  return CMD_GROUP_META[key] ?? { label: key.charAt(0).toUpperCase() + key.slice(1), icon: "fa-cube" };
}

// grouped command rows shared by /help and the settings Info dialog — collapsable, no pills, accent text takes full width
export function CommandRows({ commands }: { commands: CmdEntry[] }) {
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const needle = q.trim().toLowerCase();
  const isFiltering = !!needle;

  // build groups from filtered list so empty groups vanish
  const groups = (() => {
    const m = new Map<string, CmdEntry[]>();
    for (const c of commands) {
      if (needle && !`${c.name} ${c.description} ${c.source}`.toLowerCase().includes(needle)) continue;
      const g =
        c.source === "built-in" ? "built-in" : c.source === "skill" ? "skill" : c.source === "command" ? "command" : c.source;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    // keep friendly order: built-in first, then skills, custom, plugins, rest alpha
    const order = ["built-in", "skill", "command", "plugin"];
    return [...m.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a[0].localeCompare(b[0]);
    });
  })();

  const total = groups.reduce((n, [, list]) => n + list.length, 0);
  const totalAll = commands.length;
  const toggle = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <div>
      <div className="vc-tip">
        <i className="fa-solid fa-terminal" />
        <span>
          Type <strong>/</strong> in the composer for autocomplete — <strong>↑↓ Tab Enter Esc</strong> to pick. {totalAll} commands total
          {needle ? ` · ${total} match “${q}”` : ""}.
        </span>
      </div>
      <div className="browse-search vc-search">
        <label className="model-search-wrap" style={{ cursor: "text" }}>
          <i className="fa-solid fa-magnifying-glass" />
          <input
            className="model-search"
            placeholder="Filter commands…  e.g. compact, share, model"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) {
                e.stopPropagation();
                setQ("");
              }
            }}
          />
          {q && (
            <button type="button" className="reset-btn" onClick={() => setQ("")} data-tip="Clear filter">
              <i className="fa-solid fa-xmark" />
            </button>
          )}
        </label>
      </div>
      {groups.length === 0 ? (
        <div className="vc-empty">No commands match “{q}”</div>
      ) : (
        <div className="vc-frame">
          {groups.map(([g, list]) => {
            const meta = cmdGroupMeta(g);
            const isCollapsed = !isFiltering && collapsed.has(g);
            return (
              <div key={g} className={`vc-section${isCollapsed ? " collapsed" : ""}`}>
                <button type="button" className="vc-section-head" onClick={() => toggle(g)} aria-expanded={!isCollapsed}>
                  <i className="fa-solid fa-chevron-down vc-chevron" />
                  <i className={`fa-solid ${meta.icon}`} />
                  <span>{meta.label}</span>
                  <span className="vc-count">{list.length}</span>
                </button>
                <div className="vc-list">
                  {list.map((c) => {
                    const ex = c.takesArgs ? `/${c.name} your text…` : `/${c.name}`;
                    const hint = c.takesArgs ? "takes text" : "";
                    return (
                      <div key={c.name} className="vc-row">
                        <div className="vc-name">/{c.name}</div>
                        <div className="vc-desc">
                          {c.description || "—"}
                          {hint && <span style={{ color: "var(--text-faint)", marginLeft: 6, fontSize: "10px" }}>· {hint}</span>}
                        </div>
                        <div className="vc-ex">
                          <i className="fa-solid fa-quote-left" />
                          <span>e.g. {ex}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!needle && <p className="cmd-note">Built-in commands always work. Skills and plugins appear here when installed — custom commands come from your server’s command registry.</p>}
    </div>
  );
}

// /help — every registered command, grouped by source
export function HelpDialog({
  commands,
  onClose,
}: {
  commands: CmdEntry[];
  onClose: () => void;
}) {
  return (
    <Dialog title="Commands" onClose={onClose}>
      <CommandRows commands={commands} />
    </Dialog>
  );
}

// /variants — thinking-effort picker for the current model
export function VariantsDialog({
  variants,
  selected,
  onSelect,
  onClose,
}: {
  variants: string[];
  selected: string;
  onSelect: (v: string) => void;
  onClose: () => void;
}) {
  const opts = ["", ...variants];
  const [hi, setHi] = useState(() => Math.max(0, opts.indexOf(selected)));
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((h) => Math.min(h + 1, opts.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        onSelect(opts[hi]);
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [hi, variants]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-hl="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  return (
    <Dialog title="Thinking effort" onClose={onClose}>
      <div ref={listRef}>
        {variants.length === 0 && (
          <p className="empty">The selected model has no effort levels.</p>
        )}
        {opts.map((v, i) => (
          <button
            type="button"
            key={v || "default"}
            className={`cmd-row cmd-opt cmd-variant${i === hi ? " hl" : ""}`}
            data-hl={i === hi || undefined}
            onMouseEnter={() => setHi(i)}
            onClick={() => {
              onSelect(v);
              onClose();
            }}
          >
            <span className="mono cmd-name">/{v || "default"}</span>
            <span className="cmd-desc">{v === selected ? "active" : ""}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// /share — the session URL with a copy button
export function ShareDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  // Enter copies too
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doCopy();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [url]);

  return (
    <Dialog title="Session shared" onClose={onClose}>
      <div className="cmd-share">
        <span className="mono cmd-url">{url}</span>
        <button className="send-btn" onClick={doCopy}>
          <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="cmd-note">Anyone with the link can view this conversation.</p>
    </Dialog>
  );
}
