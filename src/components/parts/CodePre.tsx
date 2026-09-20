import { Children, isValidElement, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import MonacoBlock from "../MonacoBlock";
import { hlToMonacoLang } from "../../lib/monaco";
import { stripAnsi } from "../../lib/syntax";

// markdown helpers shared by the pre renderer below
function codeText(node: ReactNode): string {
  let out = "";
  Children.forEach(node, (c) => {
    if (typeof c === "string" || typeof c === "number") out += String(c);
    else if (isValidElement(c)) out += codeText((c.props as any).children);
  });
  return out;
}
// rehype-highlight tags the <code> with language-<id> (highlight.js ids)
function codeLang(node: ReactNode): string | undefined {
  const kids = Children.toArray(node);
  for (const c of kids) {
    if (!isValidElement(c)) continue;
    if (c.type === "code") {
      const m = /language-([\w-]+)/.exec((c.props as any).className ?? "");
      if (m) return m[1];
    }
    const nested = codeLang((c.props as any).children);
    if (nested) return nested;
  }
  return undefined;
}

// fenced code block with a fast copy button — Monaco rendering under the
// same .code-wrap chrome; copy uses the raw source so rendered markup (or
// monaco's gutter) can never corrupt it. Untagged fences stay plaintext,
// exactly like the old rehype-only rendering. Monaco editors are heavy (one
// per fence), so the editor only mounts once the block nears the viewport —
// huge histories mount <pre> placeholders until scrolled to.
export default function CodePre(props: { children?: ReactNode }) {
  const { children } = props;
  // strip terminal escapes: <pre> swallowed them invisibly, Monaco would
  // draw them as glyphs; copy matches what's seen
  const text = stripAnsi(codeText(children));
  const lang = hlToMonacoLang(codeLang(children));
  const [copied, setCopied] = useState(false);
  const [near, setNear] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (near) return;
    const el = boxRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      // upgrade ahead of the viewport so the editor is ready on arrival
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div className="code-wrap" ref={boxRef}>
      <button
        type="button"
        className="copy-btn"
        data-tip={copied ? "Copied" : "Copy"}
        aria-label="Copy code"
        onClick={copy}
      >
        <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} />
      </button>
      {near ? (
        <MonacoBlock
          value={text}
          language={lang}
          fontSize={12.5}
          lineHeight={21}
          padTop={12}
          padBottom={12}
          leftPad={14}
          className="code-mono"
          fallback={<pre>{text}</pre>}
        />
      ) : (
        <pre>{text}</pre>
      )}
    </div>
  );
}
