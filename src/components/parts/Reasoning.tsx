import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Part } from "@opencode-ai/sdk/client";
import { mdComponents } from "./mdParts";

// past this length a still-streaming part renders as plain text instead of
// re-running markdown+highlight every delta (final render on completion)
export const STREAM_RAW_LIMIT = 12000;

// one reasoning block — per-message visibility: the brain icon toggles THIS
// block only; /collapse flips the default for blocks not manually toggled
export default function Reasoning({ part, defaultOpen, streaming }: { part: Part; defaultOpen: boolean; streaming?: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? defaultOpen;
  const t = (part as any).text ?? "";
  if (!t.trim()) return null;
  return (
    <div className={`reasoning${open ? " open" : ""}`}>
      <button
        type="button"
        className="reasoning-toggle"
        data-tip={open ? "Hide thinking for this message" : "Show thinking for this message"}
        onClick={() => setManual(!open)}
      >
        <i className="fa-solid fa-brain" />
        {!open && <span className="reasoning-label">thinking</span>}
      </button>
      {/* same markdown+highlight pipeline as replies so fenced code in the
          thinking stream gets colored instead of flat grey */}
      {open && (
        <div className="reasoning-body">
          {streaming && t.length > STREAM_RAW_LIMIT ? (
            <pre className="stream-raw">{t}</pre>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
              {t}
            </Markdown>
          )}
        </div>
      )}
    </div>
  );
}
