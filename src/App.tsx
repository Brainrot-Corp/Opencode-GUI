import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Part, Permission, Session } from "@opencode-ai/sdk/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { opencode } from "./api";
import "./styles.css";

type Msg = { info: Message; parts: Part[] };

type PermAsk = { id: string; sessionID: string; type: string; title: string };

type ProviderGroup = {
  id: string;
  label: string;
  models: { id: string; label: string }[];
};

export default function App() {
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [modelSel, setModelSel] = useState("");
  const [permission, setPermission] = useState<PermAsk | null>(null);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const endRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.list();
    const list = (r.data ?? []) as Session[];
    list.reverse(); // newest first
    setSessions(list);
    return list;
  }, []);

  const openSession = useCallback(async (id: string) => {
    setActiveId(id);
    setMsgs([]);
    setBusy(false);
    setPermission(null);
    const { client } = await opencode();
    const r = await client.session.messages({ path: { id } });
    setMsgs((r.data ?? []) as Msg[]);
  }, []);

  useEffect(() => {
    let es: EventSource | undefined;
    let disposed = false;

    const onEvent = (e: any) => {
      const p = e.properties;
      switch (e.type) {
        case "message.updated": {
          const info = p.info as Message;
          if (info.sessionID !== activeRef.current) return;
          if (info.role === "assistant" && info.time?.completed) setBusy(false);
          setMsgs((prev) => {
            const i = prev.findIndex((m) => m.info.id === info.id);
            if (i < 0) return [...prev, { info, parts: [] }];
            const next = [...prev];
            next[i] = { ...next[i], info };
            return next;
          });
          break;
        }
        case "message.part.updated": {
          const part = p.part as Part;
          if (!part || part.sessionID !== activeRef.current) return;
          setMsgs((prev) => {
            const i = prev.findIndex((m) => m.info.id === part.messageID);
            if (i < 0) return prev; // message.updated creates the entry
            const next = [...prev];
            const pi = next[i].parts.findIndex((x) => x.id === part.id);
            if (pi < 0) {
              next[i] = { ...next[i], parts: [...next[i].parts, part] };
            } else {
              const parts = [...next[i].parts];
              parts[pi] = part;
              next[i] = { ...next[i], parts };
            }
            return next;
          });
          break;
        }
        case "permission.asked":
          // v1.18 emits permission.asked {id, sessionID, permission, metadata, patterns}
          if (p.sessionID === activeRef.current)
            setPermission({
              id: p.id,
              sessionID: p.sessionID,
              type: p.permission,
              title: p.metadata?.command || p.metadata?.title || (p.patterns ?? []).join(", ") || p.permission,
            });
          break;
        case "permission.updated":
          if (p.sessionID === activeRef.current) setPermission(p as Permission);
          break;
        case "session.idle":
          if (p.sessionID === activeRef.current) setBusy(false);
          break;
        case "session.deleted":
          refreshSessions().catch(() => {});
          break;
      }
    };

    (async () => {
      try {
        const { base, client } = await opencode();

        const list = await refreshSessions().catch(() => [] as Session[]);
        if (list.length > 0 && !disposed) await openSession(list[0].id);

        try {
          const pr = await client.config.providers();
          const groups: ProviderGroup[] = ((pr.data?.providers ?? []) as any[]).map((prov) => ({
            id: prov.id,
            label: prov.name || prov.id,
            models: Object.entries(prov.models ?? {}).map(([mid, m]: [string, any]) => ({
              id: mid,
              label: m.name || mid,
            })),
          }));
          groups.sort((a, b) => a.label.localeCompare(b.label));
          setProviders(groups);
        } catch {
          // provider listing is optional
        }

        es = new EventSource(`${base}/event`);
        es.onmessage = (ev) => {
          try {
            onEvent(JSON.parse(ev.data));
          } catch {
            // malformed event — ignore
          }
        };
        // onerror: EventSource reconnects automatically
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    })();

    return () => {
      disposed = true;
      es?.close();
    };
  }, [refreshSessions, openSession]);

  useEffect(() => {
    endRef.current?.scrollIntoView();
  }, [msgs]);

  async function newSession() {
    const { client } = await opencode();
    const r = await client.session.create({ body: {} });
    const s = r.data as Session;
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setMsgs([]);
    setBusy(false);
    setPermission(null);
  }

  async function send() {
    const text = input.trim();
    if (!text || !activeId || busy) return;
    setInput("");
    setBusy(true);
    try {
      const { client } = await opencode();
      const body: any = { parts: [{ type: "text", text }] };
      if (modelSel) {
        const [providerID, modelID] = modelSel.split("/");
        body.model = { providerID, modelID };
      }
      await client.session.promptAsync({ path: { id: activeId }, body });
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  }

  async function abort() {
    if (!activeId) return;
    setBusy(false);
    const { client } = await opencode();
    await client.session.abort({ path: { id: activeId } }).catch(() => {});
  }

  async function respondToPermission(response: "once" | "always" | "reject") {
    if (!permission) return;
    const perm = permission;
    setPermission(null);
    const { client } = await opencode();
    await client
      .postSessionIdPermissionsPermissionId({
        path: { id: perm.sessionID, permissionID: perm.id },
        body: { response },
      })
      .catch((e) => setError(String(e)));
  }

  async function removeSession(id: string) {
    const { client } = await opencode();
    await client.session.delete({ path: { id } }).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeId === id) {
      setActiveId("");
      setMsgs([]);
    }
  }

  function renderPart(part: Part, key: number) {
    if (part.type === "text") {
      const t = (part as any).text ?? "";
      if (!t.trim()) return null;
      return (
        <Markdown key={key} remarkPlugins={[remarkGfm]}>
          {t}
        </Markdown>
      );
    }
    if (part.type === "tool") {
      const tool = part as any;
      const status = tool.state?.status ?? "";
      const cls = status === "error" ? "error" : status === "completed" ? "done" : "";
      return (
        <div key={key} className={`tool-line ${cls}`}>
          ⚙ {tool.tool} [{status}]
        </div>
      );
    }
    return null;
  }

  return (
    <>
      <div className="noise" aria-hidden="true" />
      <div className="app">
        <header
          className="titlebar"
          data-tauri-drag-region
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest(".win-controls")) return;
            getCurrentWindow().startDragging();
          }}
        >
          <div className="brand">
            <i />
            <span>OpenCode</span>
          </div>
          <div className="win-controls">
            <button
              className="icon-btn"
              title="Minimize"
              onClick={() => getCurrentWindow().minimize()}
            >
              <svg viewBox="0 0 24 24">
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              className="icon-btn"
              title="Maximize / restore"
              onClick={() => getCurrentWindow().toggleMaximize()}
            >
              <svg viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            </button>
            <button
              className="icon-btn close"
              title="Close"
              onClick={() => getCurrentWindow().close()}
            >
              <svg viewBox="0 0 24 24">
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
            </button>
          </div>
        </header>
        <div className="layout">
        <aside className="sidebar">
          <button className="new-chat" onClick={newSession}>
            + New chat
          </button>
          {sessions.map((s) => (
            <div key={s.id} className={`session-row ${s.id === activeId ? "active" : ""}`}>
              <button className="session-item" onClick={() => openSession(s.id)} title={s.title || s.id}>
                {s.title || "New session"}
              </button>
              <button className="del" title="Delete session" onClick={() => removeSession(s.id)}>
                ×
              </button>
            </div>
          ))}
        </aside>

      <div className="main">
        {error && <div className="banner">{error}</div>}
        {!activeId ? (
          <p className="empty">Select or create a session to start.</p>
        ) : (
          <>
            <div className="messages">
              {msgs.length === 0 && !busy && <p className="empty">Say something…</p>}
              {msgs.map((m) =>
                m.parts.some((p) => renderPart(p, 0)) ? (
                  <div key={m.info.id} className={`msg ${m.info.role}`}>
                    {m.parts.map((part, i) => renderPart(part, i))}
                  </div>
                ) : m.info.role === "user" ? (
                  <div key={m.info.id} className={`msg ${m.info.role}`} />
                ) : null,
              )}
              {busy && (
                <div className="thinking">
                  <span className="cursor-dot" /> thinking
                </div>
              )}
              <div ref={endRef} />
            </div>

            {permission && (
              <div className="permission-bar">
                <div className="title">Permission required · {permission.type}</div>
                <div className="what">{permission.title}</div>
                <div className="actions">
                  <button className="allow" onClick={() => respondToPermission("once")}>
                    Allow once
                  </button>
                  <button className="allow" onClick={() => respondToPermission("always")}>
                    Always allow
                  </button>
                  <button className="deny" onClick={() => respondToPermission("reject")}>
                    Deny
                  </button>
                </div>
              </div>
            )}

            <div className="composer">
              <div className="model-row">
                <span>{modelSel ? modelSel : "server default model"}</span>
                <select value={modelSel} onChange={(e) => setModelSel(e.target.value)}>
                  <option value="">Default model</option>
                  {providers.map((g) => (
                    <optgroup key={g.id} label={g.label}>
                      {g.models.map((m) => (
                        <option key={m.id} value={`${g.id}/${m.id}`}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="composer-row">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={busy ? "Waiting for reply…" : "Ask anything (Enter to send, Shift+Enter for newline)"}
                />
                {busy ? (
                  <button className="stop-btn" onClick={abort}>
                    Stop
                  </button>
                ) : (
                  <button className="send-btn" onClick={send} disabled={!input.trim()}>
                    Send
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        </div>
      </div>
      </div>
    </>
  );
}
