import { useEffect, useRef, useState } from "react";
import Dialog from "./Dialog";
import { useMcp, toolsForServer, type McpServerState } from "../hooks/useMcp";
import type { CmdEntry } from "../hooks/useOpencode";
import "../styles/plugins.css";

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

// /mcp — loaded MCP servers grouped by this window's workspaces.
// Only workspaces in getAllWorkspaces() are queried, so servers from other
// OS windows (separate processes) never appear here.
const MCP_STATUS_META: Record<string, { label: string; color: string; icon: string }> = {
  connected: { label: "connected", color: "var(--accent)", icon: "fa-plug-circle-check" },
  disabled: { label: "disabled", color: "var(--text-faint)", icon: "fa-plug-circle-xmark" },
  failed: { label: "failed", color: "var(--danger)", icon: "fa-plug-circle-exclamation" },
  needs_auth: { label: "needs auth", color: "var(--danger)", icon: "fa-key" },
  needs_client_registration: { label: "needs registration", color: "var(--danger)", icon: "fa-key" },
};
function mcpStatusMeta(status: string) {
  return MCP_STATUS_META[status] ?? { label: status || "unknown", color: "var(--text-dim)", icon: "fa-plug" };
}
// one-line summary from workspace/global config — env values and headers are
// secrets, so only their counts are shown, never their contents
function mcpInfo(s: McpServerState): string {
  const c = s.config;
  if (!c) return "";
  const bits = [c.type === "remote" ? "remote" : "local"];
  if (c.type === "remote" && c.url) bits.push(c.url);
  else if (Array.isArray(c.command)) bits.push(c.command.join(" "));
  const env = c.environment ? Object.keys(c.environment).length : 0;
  const headers = c.headers ? Object.keys(c.headers).length : 0;
  if (env) bits.push(`+${env} env`);
  if (headers) bits.push(`+${headers} headers`);
  if (c.oauth === false) bits.push("oauth off");
  if (c.timeout) bits.push(`${c.timeout}ms`);
  return bits.join(" · ");
}
function shortDir(dir: string): string {
  const t = dir.trim();
  if (!t) return "(server directory)";
  const parts = t.split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : t;
}
export function McpDialog({ onClose }: { onClose: () => void }) {
  const { dirs, loading, busy, refresh, refreshOne, setEnabled, beginAuth, submitCode, signOut, rowKey } = useMcp();
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [authBusy, setAuthBusy] = useState<Set<string>>(new Set());
  const [authUrls, setAuthUrls] = useState<Record<string, string>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const [polling, setPolling] = useState<Set<string>>(new Set());
  const polls = useRef(new Map<string, number>());
  const needle = q.trim().toLowerCase();
  const total = dirs.reduce((n, d) => n + Object.keys(d.servers).length, 0);

  // stop browser-sign-in polling on unmount
  useEffect(() => {
    const m = polls.current;
    return () => {
      for (const id of m.values()) window.clearInterval(id);
      m.clear();
    };
  }, []);

  const stopPoll = (key: string) => {
    const id = polls.current.get(key);
    if (id !== undefined) {
      window.clearInterval(id);
      polls.current.delete(key);
    }
    setPolling((p) => {
      if (!p.has(key)) return p;
      const n = new Set(p);
      n.delete(key);
      return n;
    });
  };
  const markBusy = (key: string, on: boolean) =>
    setAuthBusy((p) => {
      const n = new Set(p);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const doRefresh = () => {
    setRefreshing(true);
    setErr("");
    refresh()
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setRefreshing(false));
  };
  const doToggle = (dir: string, name: string, enabled: boolean) => {
    setErr("");
    setEnabled(dir, name, enabled).catch((e) =>
      setErr(e instanceof Error ? e.message : String(e)),
    );
  };
  const toggleExpand = (key: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  // OAuth: open the provider URL, then poll until the sidecar callback flips
  // the status (or ~90s passes — the pasted-code path still works after that)
  const doSignIn = async (dir: string, name: string) => {
    const key = rowKey(dir, name);
    setErr("");
    markBusy(key, true);
    try {
      const url = await beginAuth(dir, name);
      setAuthUrls((p) => ({ ...p, [key]: url }));
      setExpanded((p) => new Set(p).add(key));
      stopPoll(key);
      let ticks = 0;
      const id = window.setInterval(() => {
        void (async () => {
          ticks += 1;
          try {
            const snap = await refreshOne(dir);
            const st = snap.servers[name]?.status ?? "";
            if (st !== "needs_auth" && st !== "needs_client_registration") {
              stopPoll(key);
              setAuthUrls((p) => {
                const n = { ...p };
                delete n[key];
                return n;
              });
            } else if (ticks >= 36) stopPoll(key);
          } catch {
            if (ticks >= 36) stopPoll(key);
          }
        })();
      }, 2500);
      polls.current.set(key, id);
      setPolling((p) => new Set(p).add(key));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      markBusy(key, false);
    }
  };
  const doSubmitCode = async (dir: string, name: string) => {
    const key = rowKey(dir, name);
    const code = (codes[key] ?? "").trim();
    if (!code) return;
    setErr("");
    markBusy(key, true);
    try {
      await submitCode(dir, name, code);
      stopPoll(key);
      setAuthUrls((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
      setCodes((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      markBusy(key, false);
    }
  };
  const doSignOut = async (dir: string, name: string) => {
    setErr("");
    markBusy(rowKey(dir, name), true);
    try {
      await signOut(dir, name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      markBusy(rowKey(dir, name), false);
    }
  };
  const doCopy = (key: string, url: string) => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((v) => (v === key ? "" : v)), 1500);
      },
      () => setErr("Could not copy to clipboard"),
    );
  };

  return (
    <Dialog
      title="MCP servers"
      onClose={onClose}
      wide
      actions={
        <button
          type="button"
          className="icon-btn"
          data-tip="Refresh"
          disabled={refreshing || loading}
          onClick={doRefresh}
        >
          <i className={`fa-solid fa-arrows-rotate${refreshing ? " fa-spin" : ""}`} />
        </button>
      }
    >
      <div className="vc-tip">
        <i className="fa-solid fa-plug" />
        <span>
          {loading ? "Loading…" : `${total} server${total === 1 ? "" : "s"} in this window's workspaces`}
          {needle ? ` · matching “${q}”` : ""}. Toggles persist per workspace.
        </span>
      </div>
      <div className="browse-search vc-search">
        <label className="model-search-wrap" style={{ cursor: "text" }}>
          <i className="fa-solid fa-magnifying-glass" />
          <input
            className="model-search"
            placeholder="Filter servers…  e.g. context7, failed"
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
      {err && <div className="voice-err">{err}</div>}
      {loading ? (
        <div className="vc-empty">Loading MCP servers…</div>
      ) : dirs.length === 0 ? (
        <div className="vc-empty">No workspace loaded in this window.</div>
      ) : (
        <div className="vc-frame">
          {dirs.map((d) => {
            const names = Object.keys(d.servers).sort((a, b) => a.localeCompare(b));
            const shown = needle
              ? names.filter((n) => {
                  const s = d.servers[n];
                  return `${n} ${s.status} ${s.error ?? ""} ${mcpInfo(s)} ${toolsForServer(d.tools, n).join(" ")}`.toLowerCase().includes(needle);
                })
              : names;
            if (needle && shown.length === 0 && !d.error) return null;
            return (
              <div key={d.dir || "__EMPTY__"} className="vc-section">
                <div className="vc-section-head" data-tip={d.dir || "server cwd"} style={{ cursor: "default" }}>
                  <i className="fa-solid fa-folder" />
                  <span>{shortDir(d.dir)}</span>
                  <span className="vc-count">{d.pending ? "…" : shown.length}</span>
                </div>
                {d.pending ? (
                  <div className="vc-empty">Loading…</div>
                ) : d.error ? (
                  <div className="vc-empty">{d.error}</div>
                ) : shown.length === 0 ? (
                  <div className="vc-empty">No MCP servers in this workspace.</div>
                ) : (
                  <div className="vc-list">
                    {shown.map((n) => {
                      const s = d.servers[n];
                      const meta = mcpStatusMeta(s.status);
                      const on = s.status === "connected";
                      const needsAuth = s.status === "needs_auth" || s.status === "needs_client_registration";
                      const key = rowKey(d.dir, n);
                      const isBusy = busy.has(key) || authBusy.has(key);
                      const info = mcpInfo(s);
                      const tools = toolsForServer(d.tools, n);
                      const isOpen = expanded.has(key);
                      const authUrl = authUrls[key] ?? "";
                      const isPolling = polling.has(key);
                      return (
                        <div key={n}>
                          <div className="vc-row hk">
                            <i className={`fa-solid ${meta.icon}`} style={{ color: meta.color, fontSize: 12 }} />
                            <div className="vc-desc" style={{ minWidth: 0 }}>
                              <div className="vc-name">
                                {n} <span style={{ color: meta.color, fontSize: 10 }}>· {meta.label}</span>
                              </div>
                              {info && <div style={{ marginTop: 2 }}>{info}</div>}
                              {s.error && <div style={{ color: "var(--danger)", marginTop: 2 }}>{s.error}</div>}
                            </div>
                            <button
                              type="button"
                              className="reset-btn"
                              data-tip={isOpen ? "Hide tools" : `Show tools (${tools.length})`}
                              onClick={() => toggleExpand(key)}
                            >
                              <i className={`fa-solid fa-chevron-${isOpen ? "up" : "down"}`} />
                              {tools.length > 0 ? tools.length : ""}
                            </button>
                            {needsAuth && (
                              <button
                                type="button"
                                className="reset-btn"
                                data-tip={`Sign in to ${n} in the browser`}
                                disabled={isBusy}
                                onClick={() => void doSignIn(d.dir, n)}
                              >
                                <i className="fa-solid fa-key" />
                                Sign in
                              </button>
                            )}
                            {on && s.config?.type === "remote" && (
                              <button
                                type="button"
                                className="reset-btn"
                                data-tip={`Remove saved credentials for ${n}`}
                                disabled={isBusy}
                                onClick={() => void doSignOut(d.dir, n)}
                              >
                                <i className="fa-solid fa-right-from-bracket" />
                              </button>
                            )}
                            <button
                              type="button"
                              className={`toggle${on ? " on" : ""}`}
                              aria-pressed={on}
                              data-tip={on ? `Disable ${n} in this workspace` : `Enable ${n} in this workspace`}
                              disabled={isBusy}
                              onClick={() => doToggle(d.dir, n, !on)}
                            >
                              <span className="knob" />
                            </button>
                          </div>
                          {isOpen && (
                            <div className="vc-desc" style={{ padding: "6px 10px 8px 30px" }}>
                              {tools.length === 0 ? (
                                <div style={{ color: "var(--text-faint)" }}>
                                  No tools found{on ? " — tools appear here once the server reports them" : ""}.
                                </div>
                              ) : (
                                <div>
                                  <div style={{ color: "var(--text-faint)", marginBottom: 4 }}>{tools.length} tool{tools.length === 1 ? "" : "s"}</div>
                                  {tools.map((t) => (
                                    <div key={t} className="mono" style={{ fontSize: 11, padding: "1px 0" }}>{t}</div>
                                  ))}
                                </div>
                              )}
                              {authUrl && (
                                <div style={{ marginTop: 8 }}>
                                  <div style={{ marginBottom: 4 }}>
                                    {isPolling ? "Waiting for browser sign-in… " : "Browser opened — "}
                                    <button type="button" className="reset-btn" onClick={() => doCopy(key, authUrl)} data-tip="Copy sign-in link">
                                      <i className={`fa-solid ${copied === key ? "fa-check" : "fa-copy"}`} />
                                      {copied === key ? "Copied" : "Copy link"}
                                    </button>
                                  </div>
                                  <div className="mono" style={{ fontSize: 10, overflowWrap: "anywhere", color: "var(--text-faint)" }}>{authUrl}</div>
                                  <label className="model-search-wrap" style={{ cursor: "text", marginTop: 6 }}>
                                    <i className="fa-solid fa-key" />
                                    <input
                                      className="model-search"
                                      placeholder="Or paste the authorization code…"
                                      value={codes[key] ?? ""}
                                      onChange={(e) => setCodes((p) => ({ ...p, [key]: e.target.value }))}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") void doSubmitCode(d.dir, n);
                                      }}
                                    />
                                    <button type="button" className="reset-btn" disabled={!(codes[key] ?? "").trim() || isBusy} onClick={() => void doSubmitCode(d.dir, n)} data-tip="Submit code">
                                      <i className="fa-solid fa-arrow-right" />
                                    </button>
                                  </label>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!loading && <p className="cmd-note">Disabling writes <span className="mono">enabled: false</span> to that workspace’s config and disconnects immediately. Tools are matched by the <span className="mono">{"<server>_<tool>"}</span> prefix; sign-in opens the provider in your browser.</p>}
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
