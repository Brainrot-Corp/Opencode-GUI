import { useEffect } from "react";
import { useContextMenu } from "../hooks/useContextMenu";
import { clipboardWrite, clipboardRead } from "../lib/clipboard";

export default function SelectionMenu() {
  const ctx = (() => { try { return useContextMenu(); } catch { return null; } })();
  useEffect(() => {
    if (!ctx) return;
    const handler = async (e: MouseEvent) => {
      // let session/file rows handle their own menu first
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest?.(".session-row")) return;
      if (target.closest?.(".ft-row")) return;
      // if already inside context menu, ignore
      if (target.closest?.(".ctx-menu")) return;
      // don't show on chrome where selection not expected
      // but allow everywhere — we will filter by having selection or editable
      const selText = window.getSelection()?.toString() ?? "";
      const ae = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      const isEditable = !!(ae && (
        (ae instanceof HTMLTextAreaElement) ||
        (ae instanceof HTMLInputElement && !ae.readOnly && ae.type !== "checkbox" && ae.type !== "radio") ||
        (ae as any).isContentEditable
      ));
      let hasSel = selText.length > 0;
      if (!hasSel && isEditable) {
        const s = (ae as any).selectionStart;
        const ee = (ae as any).selectionEnd;
        if (typeof s === "number" && typeof ee === "number" && s !== ee) hasSel = true;
      }
      // also check for link
      const link = (target.closest?.("a[href]") as HTMLAnchorElement | null)?.href ?? null;
      // if no selection and not editable and no link, don't show menu (keep possibly file background menu)
      if (!hasSel && !isEditable && !link) {
        // still allow menu on text containers even without selection? We show Select All / Paste
        // Check if target is inside selectable container (message, file-editor, composer)
        const selectable = target.closest?.(".msg, .filetree, .composer, .fe-stack, .message, .messages, .main, textarea, input");
        if (!selectable) return;
      }
      // async clipboard check for Paste
      let canPaste = isEditable;
      if (isEditable) {
        try {
          const t = await clipboardRead();
          // we don't strictly need content, just check editable – keep enabled even if empty (paste will do nothing)
          // but grey if clipboard truly empty and we know?
          // keep enabled optimistically; user expects Paste always there when editable
          void t;
        } catch { canPaste = false; }
      }
      const canCut = hasSel && isEditable;
      const canCopy = hasSel;
      const selForActions = selText || (() => {
        if (isEditable && ae) {
          const s = (ae as any).selectionStart ?? 0;
          const ee = (ae as any).selectionEnd ?? 0;
          return s !== ee ? String(ae.value).slice(s, ee) : "";
        }
        return "";
      })();

      const items: any[] = [];
      if (isEditable) {
        items.push({ label: "Cut", icon: "fa-scissors", disabled: !canCut, action: async () => {
          if (!canCut) return;
          const txt = selForActions;
          if (txt) await clipboardWrite(txt);
          try { document.execCommand("cut"); } catch {}
          if (isEditable && ae && (ae as any).selectionStart !== undefined) {
            const s = (ae as any).selectionStart; const ee = (ae as any).selectionEnd;
            if (typeof s === "number" && typeof ee === "number" && s !== ee) {
              const v = String((ae as any).value);
              (ae as any).value = v.slice(0, s) + v.slice(ee);
              (ae as any).selectionStart = (ae as any).selectionEnd = s;
              ae.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
        }});
      }
      items.push({ label: "Copy", icon: "fa-copy", disabled: !canCopy, action: async () => {
        const txt = selForActions || selText;
        if (txt) await clipboardWrite(txt);
      }});
      if (isEditable) {
        items.push({ label: "Paste", icon: "fa-paste", disabled: !canPaste, action: async () => {
          try {
            const t = await clipboardRead();
            if (!t) return;
            if (ae && (ae as any).setRangeText) {
              const s = (ae as any).selectionStart ?? (ae as any).value?.length ?? 0;
              const ee = (ae as any).selectionEnd ?? s;
              (ae as any).setRangeText(t, s, ee, "end");
              ae.dispatchEvent(new Event("input", { bubbles: true }));
              ae.focus();
            } else {
              // fallback execCommand
              document.execCommand("insertText", false, t);
            }
          } catch {}
        }});
      }
      // Select All always available when editable or has selection container
      items.push({ label: "Select All", icon: "fa-expand", shortcut: "Ctrl+A", action: () => {
        if (isEditable && ae && (ae as HTMLInputElement).select) {
          (ae as HTMLInputElement).select();
        } else {
          const sel = window.getSelection();
          // select nearest selectable block
          const host = target.closest?.(".msg, .message, .messages, .filetree, .composer, .main") as HTMLElement | null;
          if (host && sel) { sel.selectAllChildren(host); }
          else { document.execCommand("selectAll"); }
        }
      }});

      // extras — only when there is selection
      if (selForActions || selText) {
        const txt = selForActions || selText;
        items.push({ separator: true });
        items.push({ label: "Copy as Markdown", icon: "fa-markdown", action: async () => { await clipboardWrite(txt); } });
        items.push({ label: "Send to Composer", icon: "fa-paper-plane", action: () => {
          window.dispatchEvent(new CustomEvent("oc:voice-text", { detail: txt }));
          // focus composer textarea
          setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 0);
        }});
        items.push({ label: "Explain Selection", icon: "fa-lightbulb", action: () => {
          const q = `/explain ${txt.slice(0, 2000)}`;
          window.dispatchEvent(new CustomEvent("oc:explain", { detail: txt }));
          // fallback: send via composer submit path — dispatch to ChatPage? Use oc:voice-text then send
          // For now, just put into composer and let user send
          window.dispatchEvent(new CustomEvent("oc:voice-text", { detail: q }));
        }});
        items.push({ label: "Search in Workspace", icon: "fa-magnifying-glass", action: () => {
          // try to trigger file search — reuse opencode find if available
          window.dispatchEvent(new CustomEvent("oc:search", { detail: txt }));
          // fallback: copy and open command palette?
          // For now, also copy to clipboard
          void clipboardWrite(txt);
        }});
      }
      if (link) {
        items.push({ separator: true });
        items.push({ label: "Copy Link", icon: "fa-link", action: async () => await clipboardWrite(link) });
        items.push({ label: "Open Link", icon: "fa-arrow-up-right-from-square", action: () => {
          try { window.open(link, "_blank"); } catch {}
        }});
      }

      // if we have at least cut/copy/paste/selectall, show
      if (items.length === 0) return;
      e.preventDefault();
      ctx.show(e.clientX, e.clientY, items);
    };
    document.addEventListener("contextmenu", handler, true);
    return () => document.removeEventListener("contextmenu", handler, true);
  }, [ctx]);
  return null;
}
