import { useCallback, useEffect, useRef, useState } from "react";
import { getFindTarget, setFindTarget, targetFromElement } from "../lib/findContext";

// chat-history find — owns the Ctrl+F router (chat / composer / file-tree
// targets), the find state, and Esc / outside-close. MessageList consumes
// the state and reports hits back.
export function useChatFind(boot: { activeId: string; booting: boolean }) {
  const { activeId, booting } = boot;
  const [chatFindOpen, setChatFindOpen] = useState(false);
  const [chatFindQuery, setChatFindQuery] = useState("");
  const [chatFindCase, setChatFindCase] = useState(false);
  const [chatFindCur, setChatFindCur] = useState(0);
  const [chatFindHits, setChatFindHits] = useState(0);
  const chatFindHitsRef = useRef(0);
  chatFindHitsRef.current = chatFindHits;
  const chatFindOpenRef = useRef(chatFindOpen);
  chatFindOpenRef.current = chatFindOpen;

  const openChatFind = useCallback(() => {
    const sel = window.getSelection()?.toString() ?? "";
    if (sel && sel.length <= 120 && !sel.includes("\n")) setChatFindQuery(sel);
    setChatFindOpen(true);
    setChatFindCur(0);
    window.dispatchEvent(new CustomEvent("oc:find-opened", { detail: "chat" }));
  }, []);
  const closeChatFind = useCallback(() => {
    setChatFindOpen(false);
    window.dispatchEvent(new Event("oc:chat-find-clear"));
  }, []);
  useEffect(() => {
    const onOther = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== "chat" && chatFindOpenRef.current) {
        setChatFindOpen(false);
        window.dispatchEvent(new Event("oc:chat-find-clear"));
      }
    };
    window.addEventListener("oc:find-opened", onOther as EventListener);
    return () => window.removeEventListener("oc:find-opened", onOther as EventListener);
  }, []);
  const gotoChatFind = useCallback((idx: number) => {
    const n = chatFindHitsRef.current;
    if (!n) return;
    const j = ((idx % n) + n) % n;
    setChatFindCur(j);
  }, []);

  // track last find context for Ctrl+F routing
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = targetFromElement(e.target as Element);
      if (t) setFindTarget(t);
    };
    const onFocus = (e: FocusEvent) => {
      const t = targetFromElement(e.target as Element);
      if (t) setFindTarget(t);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("focusin", onFocus, true);
    };
  }, []);
  const hoveringFileRef = useRef(false);
  const hoveringChatRef = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = e.target as Element | null;
      const overFileTree = !!el?.closest?.(".filetree");
      const overSidebarWithFiles = !!el?.closest?.(".sidebar") && !!document.querySelector(".filetree");
      hoveringFileRef.current = overFileTree || overSidebarWithFiles;
      hoveringChatRef.current = !!el?.closest?.(".messages, .msgs-wrap");
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseleave", () => {
      hoveringFileRef.current = false;
      hoveringChatRef.current = false;
    }, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
    };
  }, []);

  // central Ctrl+F routing — capture phase to block browser find
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        const ae = document.activeElement as HTMLElement | null;
        const inComposer = !!ae?.closest(".composer");
        const hasFileEditor = !!document.querySelector(".fe-stack");
        const lastTarget = getFindTarget();
        const isHoveringFileExplorer =
          hoveringFileRef.current ||
          !!document.querySelector(".filetree:hover") ||
          (!!document.querySelector(".sidebar:hover") && !!document.querySelector(".filetree"));
        const isHoveringChat =
          hoveringChatRef.current ||
          !!document.querySelector(".messages:hover") ||
          !!document.querySelector(".msgs-wrap:hover");
        if (inComposer) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("oc:composer-find"));
          return;
        }
        if (isHoveringFileExplorer) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("oc:file-tree-find"));
          return;
        }
        if (isHoveringChat) {
          if (!activeId && !booting) return;
          e.preventDefault();
          e.stopPropagation();
          if (chatFindOpen) {
            const input = document.querySelector(".chat-find-input") as HTMLInputElement | null;
            input?.focus();
            input?.select();
            return;
          }
          openChatFind();
          return;
        }
        if (lastTarget === "file") {
          e.preventDefault();
          e.stopPropagation();
          if (hasFileEditor) window.dispatchEvent(new CustomEvent("oc:file-find"));
          else window.dispatchEvent(new CustomEvent("oc:file-tree-find"));
          return;
        }
        // otherwise chat history (covers not-focused composer case)
        if (!activeId && !booting) return;
        e.preventDefault();
        e.stopPropagation();
        if (chatFindOpen) {
          const input = document.querySelector(".chat-find-input") as HTMLInputElement | null;
          input?.focus();
          input?.select();
          return;
        }
        openChatFind();
        return;
      }
      if (k === "g" || e.key === "F3") {
        if (!chatFindOpen) return;
        // when chat find is open, handle next/prev
        const inChat = !!document.activeElement?.closest(".chat-find") || !!document.querySelector(".chat-find");
        if (inChat || chatFindOpen) {
          e.preventDefault();
          gotoChatFind(chatFindCur + (e.shiftKey ? -1 : 1));
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true } as any);
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [chatFindOpen, chatFindCur, openChatFind, gotoChatFind, activeId, booting]);

  // Esc closes chat find before other overlays
  useEffect(() => {
    if (!chatFindOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeChatFind();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true } as any);
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [chatFindOpen, closeChatFind]);
  // click outside chat find input closes it
  useEffect(() => {
    if (!chatFindOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".chat-find")) return;
      setChatFindOpen(false);
      window.dispatchEvent(new Event("oc:chat-find-clear"));
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [chatFindOpen]);

  return {
    chatFindOpen,
    chatFindQuery,
    chatFindCase,
    chatFindCur,
    chatFindHits,
    setChatFindHits,
    onFindQueryChange: useCallback((v: string) => {
      setChatFindQuery(v);
      setChatFindCur(0);
    }, []),
    onFindCaseToggle: useCallback(() => {
      setChatFindCase((c) => !c);
      setChatFindCur(0);
    }, []),
    closeChatFind,
    gotoChatFind,
  };
}
