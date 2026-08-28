// VS Code-style line editing helpers for plain <textarea> surfaces
// Used by FileEditor, Composer (subset) and Notepad plugin.
// Pure string ops + a textarea handler that preserves undo as far as
// a controlled React textarea allows (setState + rAF caret restore).

export type CommentStyle =
  | { kind: "line"; prefix: string }
  | { kind: "block"; start: string; end: string };

export function lineCommentForPath(path?: string): CommentStyle {
  if (!path) return { kind: "line", prefix: "//" };
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  // hash languages
  if (new Set(["py","pyw","rb","sh","bash","zsh","ps1","psm1","psd1","yml","yaml","toml","ini","cfg","conf","r","pl","makefile","mk","dockerfile"]).has(ext)) {
    return { kind: "line", prefix: "#" };
  }
  if (ext === "lua") return { kind: "line", prefix: "--" };
  if (new Set(["html","htm","xml","svg","vue"]).has(ext)) {
    return { kind: "block", start: "<!--", end: "-->" };
  }
  if (new Set(["css","scss","less"]).has(ext)) {
    // CSS block comment per line — VS Code uses /* */
    return { kind: "block", start: "/*", end: "*/" };
  }
  return { kind: "line", prefix: "//" };
}

function getLineAt(text: string, pos: number) {
  const p = Math.max(0, Math.min(pos, text.length));
  const start = text.lastIndexOf("\n", p - 1) + 1; // -1 -> 0
  const nl = text.indexOf("\n", p);
  const end = nl === -1 ? text.length : nl;
  const endWithNl = nl === -1 ? text.length : nl + 1;
  return { start, end, endWithNl };
}

function getBlockRange(text: string, selStart: number, selEnd: number) {
  const a = Math.max(0, Math.min(selStart, text.length));
  const b = Math.max(0, Math.min(selEnd, text.length));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) {
    const r = getLineAt(text, lo);
    return { start: r.start, end: r.end, endWithNl: r.endWithNl };
  }
  const r0 = getLineAt(text, lo);
  const r1 = getLineAt(text, hi === lo ? hi : hi - 1);
  return { start: r0.start, end: r1.end, endWithNl: r1.endWithNl };
}

export function copyToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  // fallback — execCommand
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch {}
}

// --- pure ops (return new text + caret) ---

export function opCopyLine(text: string, pos: number): string | null {
  const { start, endWithNl } = getLineAt(text, pos);
  return text.slice(start, endWithNl);
}

export function opCutLine(text: string, pos: number): { text: string; caret: number } {
  const { start, endWithNl } = getLineAt(text, pos);
  return { text: text.slice(0, start) + text.slice(endWithNl), caret: start };
}

export function opDeleteLine(text: string, selStart: number, selEnd: number): { text: string; caret: number } {
  const { start, endWithNl } = getBlockRange(text, selStart, selEnd);
  // if deleting the whole text, return empty
  if (start === 0 && endWithNl === text.length) return { text: "", caret: 0 };
  return { text: text.slice(0, start) + text.slice(endWithNl), caret: Math.min(start, text.length) };
}

export function opDuplicate(text: string, selStart: number, selEnd: number, dir: "up" | "down"): { text: string; caret: number } {
  const { start, end, endWithNl } = getBlockRange(text, selStart, selEnd);
  const hasNl = endWithNl > end;
  const block = hasNl ? text.slice(start, endWithNl) : text.slice(start, end);
  if (!block && hasNl) return { text, caret: selStart };
  if (!block && !hasNl) return { text, caret: selStart };
  // block without trailing newline (last line) needs a separator
  if (!hasNl) {
    if (dir === "down") {
      const nt = text.slice(0, end) + "\n" + block + text.slice(end);
      const caret = end + 1 + (selStart - start);
      return { text: nt, caret };
    } else {
      const nt = text.slice(0, start) + block + "\n" + text.slice(start);
      const caret = start + (selStart - start);
      return { text: nt, caret };
    }
  }
  if (dir === "down") {
    const nt = text.slice(0, endWithNl) + block + text.slice(endWithNl);
    const caret = endWithNl + (selStart - start);
    return { text: nt, caret };
  } else {
    const nt = text.slice(0, start) + block + text.slice(start);
    const caret = start + (selStart - start);
    return { text: nt, caret };
  }
}

export function opMoveLine(text: string, selStart: number, selEnd: number, dir: "up" | "down"): { text: string; caret: number } | null {
  const { start, end } = getBlockRange(text, selStart, selEnd);
  // compute line indices via newline count (robust for trailing newline)
  const startLine = (text.slice(0, start).match(/\n/g) ?? []).length;
  const endLine = (text.slice(0, end).match(/\n/g) ?? []).length;
  const lines = text.split("\n");
  const count = endLine - startLine + 1;
  if (dir === "down") {
    if (endLine >= lines.length - 1) return null;
    // if last element is "" from trailing newline, don't move into it as if it's a real line
    if (lines[lines.length - 1] === "" && endLine === lines.length - 2) {
      // moving the second-last line down would swap with the trailing empty line -> produce extra newline; allow but treat as move
    }
    const nextLine = lines[endLine + 1];
    const block = lines.splice(startLine, count);
    // after removal, nextLine is now at startLine
    lines.splice(startLine + 1, 0, ...block);
    const nt = lines.join("\n");
    const caret = selStart + nextLine.length + 1;
    return { text: nt, caret: Math.min(caret, nt.length) } as any;
  } else {
    if (startLine === 0) return null;
    const prevLine = lines[startLine - 1];
    const block = lines.splice(startLine, count);
    lines.splice(startLine - 1, 0, ...block);
    const nt = lines.join("\n");
    const caret = selStart - (prevLine.length + 1);
    return { text: nt, caret: Math.max(0, caret) } as any;
  }
}

export function opSelectLine(text: string, pos: number): { start: number; end: number } {
  const { start, end } = getLineAt(text, pos);
  return { start, end };
}

export function opInsertLine(text: string, pos: number, dir: "above" | "below"): { text: string; caret: number } {
  const { start, endWithNl } = getLineAt(text, pos);
  if (dir === "below") {
    // insert empty line after current line
    const insAt = endWithNl;
    const nt = text.slice(0, insAt) + "\n" + text.slice(insAt);
    // caret at start of new line
    return { text: nt, caret: insAt };
  } else {
    const nt = text.slice(0, start) + "\n" + text.slice(start);
    // if block started at 0, new line is at 0, caret there; else caret moves?
    // VS Code inserts above and places caret on the new line at same indent
    return { text: nt, caret: start };
  }
}

export function opToggleComment(text: string, selStart: number, selEnd: number, style: CommentStyle): { text: string; caret: number; selEnd: number } {
  const { start, endWithNl } = getBlockRange(text, selStart, selEnd);
  const block = text.slice(start, endWithNl);
  const lines = block.split("\n");
  const hasTrailingNl = block.endsWith("\n");
  const rawLines = hasTrailingNl ? lines.slice(0, -1) : lines;
  // determine if all non-empty lines already commented
  const isLine = style.kind === "line";
  const prefix = isLine ? (style as { prefix: string }).prefix : "";
  const isBlocked = style.kind === "block";
  const bStart = isBlocked ? (style as { start: string; end: string }).start : "";
  const bEnd = isBlocked ? (style as { start: string; end: string }).end : "";

  const nonEmpty = rawLines.filter((l) => l.trim().length > 0);
  let allCommented = false;
  if (isLine) {
    allCommented = nonEmpty.length > 0 && nonEmpty.every((l) => l.trimStart().startsWith(prefix));
  } else {
    allCommented = nonEmpty.length > 0 && nonEmpty.every((l) => {
      const t = l.trim();
      return t.startsWith(bStart) && t.endsWith(bEnd);
    });
  }

  const outLines = rawLines.map((l) => {
    if (l.trim().length === 0) return l;
    const indentLen = l.length - l.trimStart().length;
    const indent = l.slice(0, indentLen);
    const rest = l.slice(indentLen);
    if (isLine) {
      if (allCommented) {
        // uncomment: remove prefix + optional single space
        if (rest.startsWith(prefix + " ")) return indent + rest.slice(prefix.length + 1);
        if (rest.startsWith(prefix)) return indent + rest.slice(prefix.length);
        return l;
      } else {
        return indent + prefix + " " + rest;
      }
    } else {
      if (allCommented) {
        // strip block wrappers
        let t = rest.trim();
        // remove start/end with optional spaces
        if (t.startsWith(bStart)) t = t.slice(bStart.length).trimStart();
        if (t.endsWith(bEnd)) t = t.slice(0, -bEnd.length).trimEnd();
        return indent + t;
      } else {
        return indent + bStart + " " + rest + " " + bEnd;
      }
    }
  });

  let newBlock = outLines.join("\n");
  if (hasTrailingNl) newBlock += "\n";
  const nt = text.slice(0, start) + newBlock + text.slice(endWithNl);
  // keep caret roughly at same offset (biased to start)
  const caret = Math.min(start, nt.length);
  const newSelEnd = caret + newBlock.length - (hasTrailingNl ? 1 : 0);
  return { text: nt, caret, selEnd: newSelEnd };
}

// central key handler — call from textarea onKeyDown
// returns true if handled (caller should not proceed)
export function handleEditorKeys(
  e: React.KeyboardEvent<HTMLTextAreaElement> | KeyboardEvent,
  textarea: HTMLTextAreaElement,
  text: string,
  setText: (s: string) => void,
  opts: { path?: string; allowInsert?: boolean } = {},
): boolean {
  const ta = textarea;
  const ctrl = (e as any).ctrlKey || (e as any).metaKey; // either for cross-plat
  const key = (e as any).key as string;
  const code = (e as any).code as string;
  // let native undo/redo through — controlled textarea still relies on browser history
  if (ctrl && !e.altKey && (key.toLowerCase() === "z" || key.toLowerCase() === "y")) return false;
  const hasSel = ta.selectionStart !== ta.selectionEnd;
  const pos = ta.selectionStart ?? 0;

  // --- Ctrl/Cmd+C copy line when no selection ---
  if (ctrl && !e.altKey && !e.shiftKey && key.toLowerCase() === "c" && !hasSel) {
    const line = opCopyLine(text, pos);
    if (line != null) {
      e.preventDefault();
      copyToClipboard(line);
      return true;
    }
  }
  // --- Ctrl/Cmd+X cut line when no selection ---
  if (ctrl && !e.altKey && !e.shiftKey && key.toLowerCase() === "x" && !hasSel) {
    const line = opCopyLine(text, pos);
    const cut = opCutLine(text, pos);
    e.preventDefault();
    if (line) copyToClipboard(line);
    setText(cut.text);
    requestAnimationFrame(() => {
      try { ta.setSelectionRange(cut.caret, cut.caret); } catch {}
    });
    return true;
  }

  // --- Ctrl/Cmd+Shift+K delete line ---
  if (ctrl && (e as any).shiftKey && !e.altKey && key.toLowerCase() === "k") {
    e.preventDefault();
    const r = opDeleteLine(text, ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    setText(r.text);
    requestAnimationFrame(() => {
      try { ta.setSelectionRange(r.caret, r.caret); } catch {}
    });
    return true;
  }

  // --- Ctrl/Cmd+L select line ---
  if (ctrl && !e.altKey && !e.shiftKey && key.toLowerCase() === "l") {
    e.preventDefault();
    const { start, end } = opSelectLine(text, pos);
    requestAnimationFrame(() => {
      try { ta.setSelectionRange(start, end); } catch {}
    });
    return true;
  }

  // --- Ctrl/Cmd+/ toggle comment ---
  // e.key is "/" on US, e.code is "Slash". Handle both and NumpadDivide.
  const isSlash = key === "/" || code === "Slash" || code === "NumpadDivide";
  if (ctrl && !e.altKey && !e.shiftKey && isSlash) {
    e.preventDefault();
    const style = lineCommentForPath(opts.path);
    const r = opToggleComment(text, ta.selectionStart ?? 0, ta.selectionEnd ?? 0, style);
    setText(r.text);
    requestAnimationFrame(() => {
      try { ta.setSelectionRange(r.caret, r.selEnd); } catch {}
    });
    return true;
  }

  // --- Alt+Up/Down move line, Shift+Alt+Up/Down duplicate ---
  // must check altKey without ctrl
  if (e.altKey && !ctrl && (key === "ArrowUp" || key === "ArrowDown")) {
    e.preventDefault();
    const isDup = (e as any).shiftKey;
    if (isDup) {
      const dir = key === "ArrowUp" ? "up" : "down";
      const r = opDuplicate(text, ta.selectionStart ?? 0, ta.selectionEnd ?? 0, dir);
      setText(r.text);
      requestAnimationFrame(() => {
        try { ta.setSelectionRange(r.caret, r.caret); } catch {}
      });
    } else {
      const dir = key === "ArrowUp" ? "up" : "down";
      const r = opMoveLine(text, ta.selectionStart ?? 0, ta.selectionEnd ?? 0, dir);
      if (!r) return true;
      setText(r.text);
      requestAnimationFrame(() => {
        try { ta.setSelectionRange(r.caret, r.caret); } catch {}
      });
    }
    return true;
  }

  // --- Ctrl/Cmd+Enter insert line below, Ctrl/Cmd+Shift+Enter above ---
  if (opts.allowInsert && ctrl && key === "Enter") {
    e.preventDefault();
    const dir = (e as any).shiftKey ? "above" : "below";
    const r = opInsertLine(text, pos, dir);
    setText(r.text);
    requestAnimationFrame(() => {
      try { ta.setSelectionRange(r.caret, r.caret); } catch {}
    });
    return true;
  }

  return false;
}

// minimal subset for Composer — only C/X line copy/cut
export function handleComposerKeys(
  e: React.KeyboardEvent<HTMLTextAreaElement> | KeyboardEvent,
  textarea: HTMLTextAreaElement,
  text: string,
  setText: (s: string) => void,
): boolean {
  const ctrl = (e as any).ctrlKey || (e as any).metaKey;
  const key = (e as any).key as string;
  if (ctrl && !e.altKey && (key.toLowerCase() === "z" || key.toLowerCase() === "y")) return false;
  const hasSel = textarea.selectionStart !== textarea.selectionEnd;
  const pos = textarea.selectionStart ?? 0;
  if (ctrl && !e.altKey && !e.shiftKey && key.toLowerCase() === "c" && !hasSel) {
    const line = opCopyLine(text, pos);
    if (line != null) {
      e.preventDefault();
      copyToClipboard(line);
      return true;
    }
  }
  if (ctrl && !e.altKey && !e.shiftKey && key.toLowerCase() === "x" && !hasSel) {
    const line = opCopyLine(text, pos);
    const cut = opCutLine(text, pos);
    e.preventDefault();
    if (line) copyToClipboard(line);
    setText(cut.text);
    requestAnimationFrame(() => {
      try { textarea.setSelectionRange(cut.caret, cut.caret); } catch {}
    });
    return true;
  }
  return false;
}

// ponytail: demo self-check — run with `npx tsx src/lib/editorKeys.ts`
const _proc: any = (globalThis as any).process;
if (typeof _proc !== "undefined" && _proc.argv?.[1]?.endsWith("editorKeys.ts")) {
  const assert = (a: any, b: any, msg: string) => {
    if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  // copy line
  assert(opCopyLine("a\nb\nc", 0), "a\n", "copy first");
  assert(opCopyLine("a\nb\nc", 2), "b\n", "copy mid");
  assert(opCopyLine("a\nb", 2), "b", "copy last no nl");
  // cut line
  assert(opCutLine("a\nb\nc", 2).text, "a\nc", "cut mid");
  // delete block
  assert(opDeleteLine("a\nb\nc", 0, 0).text, "b\nc", "delete first");
  // duplicate down
  assert(opDuplicate("a\nb", 0, 0, "down").text, "a\na\nb", "dup down");
  assert(opDuplicate("a\nb", 2, 2, "up").text, "a\nb\nb", "dup up"); // caret at b line, dup up => inserted before b
  // move
  assert(opMoveLine("a\nb\nc", 0, 0, "down")!.text, "b\na\nc", "move down");
  assert(opMoveLine("a\nb\nc", 4, 4, "up")!.text, "a\nc\nb", "move up");
  // select
  assert(JSON.stringify(opSelectLine("a\nb\nc", 2)), JSON.stringify({ start: 2, end: 3 }), "select");
  // insert
  assert(opInsertLine("a\nb", 0, "below").text, "a\n\nb", "insert below");
  assert(opInsertLine("a\nb", 0, "above").text, "\na\nb", "insert above");
  // comment //
  let r = opToggleComment("a\nb", 0, 0, { kind: "line", prefix: "//" });
  assert(r.text, "// a\nb", "comment line");
  r = opToggleComment(r.text, 0, 0, { kind: "line", prefix: "//" });
  assert(r.text, "a\nb", "uncomment");
  // comment #
  r = opToggleComment("x\ny", 0, 3, { kind: "line", prefix: "#" });
  assert(r.text, "# x\n# y", "hash comment");
  console.log("editorKeys self-check passed");
}
