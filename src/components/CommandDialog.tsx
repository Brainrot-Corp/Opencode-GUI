import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Dialog from "./Dialog";
import type { CmdEntry } from "../hooks/useOpencode";

// grouped command rows shared by /help and the settings Info dialog
export function CommandRows({ commands }: { commands: CmdEntry[] }) {
  const groups = new Map<string, CmdEntry[]>();
  for (const c of commands) {
    const g =
      c.source === "built-in" ? "built-in" : c.source === "skill" ? "skill" : c.source === "command" ? "command" : c.source;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }
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
    const mo = new MutationObserver(update);
    mo.observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    (document as any).fonts?.ready?.then?.(update);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [commands]);
  return (
    <div ref={ref}>
      {[...groups.entries()].map(([g, list]) => (
        <div key={g} className="cmd-group cmd-group--pills left">
          <div className="cmd-group-label">{g}</div>
          {list.map((c) => (
            <div key={c.name} className="cmd-row hk-row static">
              <span className="mono cmd-name hk-pill fixed left">/{c.name}</span>
              <span className="cmd-desc">{c.description || "—"}</span>
            </div>
          ))}
        </div>
      ))}
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
