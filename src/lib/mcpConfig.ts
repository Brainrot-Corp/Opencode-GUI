// comment-preserving "enabled" flip for opencode.jsonc — no new deps, so a
// tiny string/comment-aware scanner instead of a JSONC parser. Only the
// enabled token (or its insertion) is touched; every other byte survives.
export function setMcpEnabled(raw: string, name: string, enabled: boolean, entry: unknown): string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`No stored config for MCP server "${name}" — add it to opencode.jsonc first.`);
  }
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  const want = enabled ? "true" : "false";
  const unit = detectIndent(text);

  if (!text.trim()) return freshFile(name, entry, unit);

  const lx = lex(text);
  const root = firstBraceAt(lx, 0, 0, true);
  if (root === null) throw new Error("opencode.jsonc has no root object — refusing to edit.");
  const rootClose = matchClose(lx, root);
  if (onlyWsOrComments(text, rootClose + 1, text.length) === false) {
    throw new Error("Unexpected content in opencode.jsonc — refusing to edit.");
  }
  const mcpKey = findKey(lx, root + 1, rootClose, 1, "mcp");
  if (!mcpKey) {
    return insertKey(text, root, rootClose, "mcp", pretty({ [name]: entry }, unit, 1), unit);
  }
  const mcpVal = valueStart(text, mcpKey.colon);
  if (text[mcpVal] !== "{") throw new Error(`"mcp" in opencode.jsonc is not an object — refusing to edit.`);
  const mcpClose = matchClose(lx, mcpVal);
  const srvKey = findKey(lx, mcpVal + 1, mcpClose, 2, name);
  if (!srvKey) {
    return insertKey(text, mcpVal, mcpClose, name, pretty(entry, unit, 2), unit);
  }
  const srvVal = valueStart(text, srvKey.colon);
  if (text[srvVal] !== "{") throw new Error(`MCP server "${name}" is not an object — edit opencode.jsonc manually.`);
  const srvClose = matchClose(lx, srvVal);
  const enKey = findKey(lx, srvVal + 1, srvClose, 3, "enabled");
  if (enKey) {
    const vs = valueStart(text, enKey.colon);
    const m = /^(true|false|null|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(vs));
    if (!m) throw new Error(`Unexpected "enabled" value for "${name}" — edit opencode.jsonc manually.`);
    return text.slice(0, vs) + want + text.slice(vs + m[0].length);
  }
  return insertKey(text, srvVal, srvClose, "enabled", want, unit);
}

function freshFile(name: string, entry: unknown, unit: string): string {
  const u = unit;
  return `{\n${u}"$schema": "https://opencode.ai/config.json",\n${u}"mcp": {\n${u}${u}"${escapeKey(name)}": ${pretty(entry, unit, 2)}\n${u}}\n}\n`;
}

// JSON.stringify with the file's own indent unit, shifted to nest at level
function pretty(v: unknown, unit: string, level: number): string {
  const pad = unit.repeat(level);
  return JSON.stringify(v, null, unit)!.split("\n").map((l, i) => (i === 0 || !l.trim() ? l : pad + l)).join("\n");
}

function escapeKey(k: string): string {
  return k.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function detectIndent(text: string): string {
  const m = /^([ \t]+)"[^"\n]+"\s*:/m.exec(text);
  const u = m ? m[1] : "  ";
  return u.length > 10 ? "  " : u;
}

// insert "key": valueJson into the object [open..close] before its closing
// brace, comma-aware. The object itself is never reformatted.
function insertKey(text: string, open: number, close: number, key: string, valueJson: string, unit: string): string {
  const hasContent = !onlyWsOrComments(text, open + 1, close);
  const childPad = lineIndent(text, close) + unit;
  const ins = `${hasContent ? ",\n" : "\n"}${childPad}"${escapeKey(key)}": ${valueJson}\n${lineIndent(text, close)}`;
  return text.slice(0, close) + ins + text.slice(close);
}

function lineIndent(text: string, idx: number): string {
  const ls = text.lastIndexOf("\n", idx - 1);
  const m = /^[ \t]*/.exec(text.slice(ls + 1));
  return m ? m[0] : "";
}

function onlyWsOrComments(text: string, from: number, to: number): boolean {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? to : nl + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0 || end + 2 > to) return false;
      i = end + 2;
      continue;
    }
    return false;
  }
  return true;
}

type KeyTok = { name: string; colon: number; depth: number };
type BraceTok = { idx: number; open: boolean; depth: number };
type Lex = { keys: KeyTok[]; braces: BraceTok[] };

// single pass: string/comment-aware brace depths + colon keys. Throws on
// unterminated string/comment or unbalanced braces.
function lex(text: string): Lex {
  const keys: KeyTok[] = [];
  const braces: BraceTok[] = [];
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === "\\") i += 2;
        else if (text[i] === '"') {
          closed = true;
          break;
        } else i++;
      }
      if (!closed) throw new Error("Unterminated string in opencode.jsonc — refusing to edit.");
      const end = i;
      i++; // past closing quote
      let j = i;
      while (j < n) {
        const d = text[j];
        if (d === " " || d === "\t" || d === "\n" || d === "\r") j++;
        else if (d === "/" && text[j + 1] === "/") {
          const nl = text.indexOf("\n", j + 2);
          j = nl < 0 ? n : nl + 1;
        } else if (d === "/" && text[j + 1] === "*") {
          const end2 = text.indexOf("*/", j + 2);
          if (end2 < 0) throw new Error("Unterminated comment in opencode.jsonc — refusing to edit.");
          j = end2 + 2;
        } else break;
      }
      if (text[j] === ":") {
        let name = text.slice(start + 1, end);
        try {
          name = JSON.parse(text.slice(start, end + 1));
        } catch {}
        keys.push({ name, colon: j, depth });
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated comment in opencode.jsonc — refusing to edit.");
      i = end + 2;
      continue;
    }
    if (c === "{") {
      braces.push({ idx: i, open: true, depth });
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth < 0) throw new Error("Unbalanced braces in opencode.jsonc — refusing to edit.");
      braces.push({ idx: i, open: false, depth });
      i++;
      continue;
    }
    i++;
  }
  if (depth !== 0) throw new Error("Unbalanced braces in opencode.jsonc — refusing to edit.");
  return { keys, braces };
}

function firstBraceAt(lx: Lex, from: number, depth: number, open: boolean): number | null {
  for (const b of lx.braces) {
    if (b.idx >= from && b.open === open && b.depth === depth) return b.idx;
  }
  return null;
}

function matchClose(lx: Lex, openIdx: number): number {
  const open = lx.braces.find((b) => b.idx === openIdx && b.open);
  if (!open) throw new Error("Unexpected content in opencode.jsonc — refusing to edit.");
  const close = lx.braces.find((b) => !b.open && b.depth === open.depth && b.idx > openIdx);
  if (!close) throw new Error("Unbalanced braces in opencode.jsonc — refusing to edit.");
  return close.idx;
}

function findKey(lx: Lex, from: number, to: number, depth: number, name: string): KeyTok | null {
  for (const k of lx.keys) {
    if (k.depth === depth && k.name === name && k.colon >= from && k.colon <= to) return k;
  }
  return null;
}

function valueStart(text: string, colon: number): number {
  let i = colon + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated comment in opencode.jsonc — refusing to edit.");
      i = end + 2;
      continue;
    }
    return i;
  }
  throw new Error("Unexpected content in opencode.jsonc — refusing to edit.");
}
