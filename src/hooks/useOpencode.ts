import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, Part, Session } from "@opencode-ai/sdk/client";
import { opencode } from "../api";
import type { Msg, OpenCodeEvent, PermAsk, ProviderGroup } from "../types";

export function useOpencode() {
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [modelSel, setModelSel] = useState("");
  const [permission, setPermission] = useState<PermAsk | null>(null);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;

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

    const onEvent = (e: OpenCodeEvent) => {
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
              title:
                p.metadata?.command ||
                p.metadata?.title ||
                (p.patterns ?? []).join(", ") ||
                p.permission,
            });
          break;
        case "permission.updated":
          if (p.sessionID === activeRef.current)
            setPermission({
              id: p.id,
              sessionID: p.sessionID,
              type: p.type,
              title: p.title ?? p.type,
            });
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

  const newSession = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.create({ body: {} });
    const s = r.data as Session;
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setMsgs([]);
    setBusy(false);
    setPermission(null);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text || !activeId || busy) return;
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
    },
    [activeId, busy, modelSel],
  );

  const abort = useCallback(async () => {
    if (!activeId) return;
    setBusy(false);
    const { client } = await opencode();
    await client.session.abort({ path: { id: activeId } }).catch(() => {});
  }, [activeId]);

  const respondToPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
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
    },
    [permission],
  );

  const removeSession = useCallback(
    async (id: string) => {
      const { client } = await opencode();
      await client.session.delete({ path: { id } }).catch(() => {});
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeRef.current === id) {
        setActiveId("");
        setMsgs([]);
      }
    },
    [],
  );

  return {
    error,
    sessions,
    activeId,
    msgs,
    busy,
    providers,
    modelSel,
    setModelSel,
    permission,
    newSession,
    openSession,
    send,
    abort,
    respondToPermission,
    removeSession,
  };
}
