// Terminal output syntax highlighting: re-colors runs of PLAIN text lines
// through lowlight before xterm renders them, so cat'd source / build logs /
// compiler output get chat-code-block coloring while staying cursor-safe.
//
// Design: sits between the PTY stream and term.write. Chunks carrying ANSI
// escapes (apps that color themselves — ls, git, PSReadLine echo — and ALL
// control codes) pass through verbatim; we never touch cursor tracking.
// Escape-free lines accumulate into a BLOCK (blank lines flush it); the
// block's language is picked by structural fingerprints, NOT highlightAuto —
// measured against real samples, hljs auto-detect scores JS as css/ini more
// often than not on terminal-sized blocks. Unrecognized shapes stay
// uncolored: wrong colors are worse than none. Ceiling (ponytail): blocks
// split at blank lines, so one giant function separated by blanks highlights
// in chunks.
import { createLowlight, common } from "lowlight";

const ll = createLowlight(common);

// flood guards: oversized backlog skips straight to raw passthrough, and a
// slow highlight pauses coloring briefly instead of janking the UI
const MAX_PARTIAL = 8192;
const MAX_BLOCK_LINES = 120;
const MAX_BLOCK_BYTES = 12288;
const FLUSH_MS = 16;
// generous: the first highlight compiles grammars and can take tens of ms —
// only sustained slowness (pathological floods) should trip the ban
const HL_BAN_MS = 2000;
const HL_SLOW_MS = 40;

// structural fingerprint → registered language. First match wins; order =
// specificity (json before js, python before bash…)
const LANG_HINTS: [RegExp, string][] = [
  [/^\s*\{[\s\S]*\}\s*$|^\s*\[[\s\S]*\]\s*$/, "json"],
  [
    /^\s*(?:def |class |elif |except |from \w+ import |import \w+(?: as \w+)?\s*$|print\(|@\w+)/m,
    "python",
  ],
  [/\b(?:fn |let mut |impl |match\s+\w+\s*\{|println!|use \w+::)/, "rust"],
  [/\b(?:func |package \w+|fmt\.Print|\w+ :=)/, "go"],
  [/^\s*(?:using \w+;|namespace \w+|public class |Console\.Write)/m, "csharp"],
  [/^\s*(?:import java\.|public class |System\.out\.)/m, "java"],
  [/^\s*#include|std::|int main\(/m, "cpp"],
  [/^\s*(?:SELECT .+ FROM|INSERT INTO |CREATE TABLE |UPDATE \w+ SET)/im, "sql"],
  [/(?:interface \w+ \{|: (?:string|number|boolean)\b)/, "typescript"],
  [/\b(?:const |let |var |function |return )|=>|console\.log|require\(/, "javascript"],
  [
    /^\s*(?:\$ |PS> )?(?:git|gh|npm|npx|pnpm|yarn|bun|cargo|docker|kubectl|python3?|pip3?|node|deno|make|cmake|curl|wget)\b/m,
    "bash",
  ],
];

function guessLang(block: string): string | null {
  for (const [re, lang] of LANG_HINTS) {
    if (re.test(block) && ll.registered(lang)) return lang;
  }
  return null;
}

// hljs class family → SGR foreground. The 16-color codes land on the theme's
// ANSI palette (Terminal.tsx maps them onto the syntax tokens), so
// highlighted output follows theme switches like everything else
const CLASS_SGR: [RegExp, string][] = [
  [/^(comment|quote|meta|doctag)$/, "90"],
  [/^(string|string\..+|regexp|addition)$/, "32"],
  [/^(number)$/, "33"],
  [/^(literal)$/, "36"],
  [/^(keyword|keyword.+|built_in|selector-.+|name)$/, "36"],
  [/^(title|title.+|function_.+)$/, "96"],
  [/^(type|class|attr|attribute|property)$/, "94"],
  [/^(deletion)$/, "91"],
];

function sgrFor(classes: unknown): string | null {
  if (!Array.isArray(classes)) return null;
  for (const cn of classes as string[]) {
    if (typeof cn !== "string" || !cn.startsWith("hljs-")) continue;
    const short = cn.slice(5);
    for (const [re, code] of CLASS_SGR) if (re.test(short)) return code;
  }
  return null;
}

// hast tree → text with per-span SGR wraps (\x1b[Nm … \x1b[39m restores
// default fg). Newlines inside text nodes pass through — SGR state survives
// them, so multi-line strings/comments color correctly end to end
function emit(node: any, color: string | null, acc: string[]): void {
  if (node.type === "text") {
    if (!node.value) return;
    acc.push(color ? `\x1b[${color}m${node.value}\x1b[39m` : node.value);
    return;
  }
  if (node.type !== "element") return;
  const next = sgrFor((node.properties as { className?: unknown } | undefined)?.className) ?? color;
  for (const c of node.children ?? []) emit(c, next, acc);
}

// per-instance ban — moved inside class so one noisy term doesn't mute others
function tryHighlightBlock(block: string, hl: TermHighlighter): string | null {
  const now = performance.now();
  if (now < hl.hlBanUntil) return null;
  // binary / non-utf8 passthrough: don't color blocks containing NUL or many replacements
  if (block.includes("\x00") || block.includes("\uFFFD")) return null;
  const lang = guessLang(block);
  if (!lang) return null;
  let tree;
  const t0 = performance.now();
  try {
    tree = ll.highlight(lang, block);
  } catch {
    return null;
  }
  if (performance.now() - t0 > HL_SLOW_MS) hl.hlBanUntil = performance.now() + HL_BAN_MS;
  const acc: string[] = [];
  for (const c of tree.children ?? []) emit(c, null, acc);
  return acc.join("");
}

export class TermHighlighter {
  private dec = new TextDecoder();
  private partial = ""; // incomplete line (prompts live here until flushed)
  private block: string[] = []; // consecutive plain complete lines
  private blockBytes = 0;
  private timer = 0;
  private escTail = ""; // incomplete escape sequence waiting for its rest
  private out: (s: string) => void;
  hlBanUntil = 0;

  constructor(out: (s: string) => void) {
    this.out = out;
  }

  // bytes may split UTF-8 chars mid-chunk — TextDecoder(stream) reassembles.
  // Chunks are SPLIT into escape/plain segments rather than judged whole:
  // ConPTY + PSReadLine interleave redraw escapes with command output in the
  // same read frame, so "contains ESC → bypass" would exempt everything
  write(bytes: Uint8Array): void {
    // binary passthrough: NUL byte means not text — flush and emit raw without highlight
    if (bytes.includes(0)) {
      this.flush();
      // decode without stream to avoid polluting partial with � splinters
      try { this.out(new TextDecoder().decode(bytes)); } catch { this.out(String.fromCharCode(...bytes)); }
      return;
    }
    let text = this.dec.decode(bytes, { stream: true });
    if (!text) return;
    // if decoded chunk is mostly replacement chars, treat as binary
    if (text.includes("\uFFFD") && (text.match(/\uFFFD/g) ?? []).length > text.length * 0.3) {
      this.flush();
      this.out(text);
      return;
    }
    if (this.escTail) {
      text = this.escTail + text;
      this.escTail = "";
    }
    let i = 0;
    while (i < text.length) {
      const esc = text.indexOf("\x1b", i);
      if (esc < 0) {
        this.feedPlain(text.slice(i));
        return;
      }
      if (esc > i) this.feedPlain(text.slice(i, esc));
      const end = seqEnd(text, esc);
      if (end === -1) {
        // sequence continues in the next chunk — hold it, flush text first
        this.flush();
        this.escTail = text.slice(esc);
        return;
      }
      this.flush();
      this.out(text.slice(esc, end));
      i = end;
    }
  }

  private feedPlain(text: string): void {
    this.partial += text;
    const nl = this.partial.lastIndexOf("\n");
    if (nl >= 0) {
      const done = this.partial.slice(0, nl);
      this.partial = this.partial.slice(nl + 1);
      for (const line of done.split("\n")) {
        const body = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (body.trim() === "") {
          // blank line = block boundary: ship what we have, then the blank
          this.flushBlock();
          this.out(body === "" ? "\n" : body + "\n");
          continue;
        }
        this.block.push(body);
        this.blockBytes += body.length;
        if (this.block.length >= MAX_BLOCK_LINES || this.blockBytes >= MAX_BLOCK_BYTES) {
          this.flushBlock();
        }
      }
    }
    if (this.partial.length > MAX_PARTIAL) {
      this.flush();
      // reset SGR so a truncated long line doesn't bleed color into next chunk
      this.out("\x1b[0m");
      return;
    }
    // hold tails briefly to coalesce micro-frames into fewer term.write calls —
    // MUST stay ≈1 frame (16ms): zsh echoes typed keys as plain text (no ESC),
    // so interactive echo lives here while typing, and every keystroke resets
    // the timer. Higher values batch keystrokes into visible bursts. Escape-
    // carrying chunks (PSReadLine redraws, spinners) bypass this hold entirely;
    // the line/byte caps above are the real flood valve
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), FLUSH_MS) as unknown as number;
  }

  // ship any held content raw — prompts land uncolored, nothing is lost
  flush(): void {
    clearTimeout(this.timer);
    this.flushBlock();
    if (this.partial) {
      this.out(this.partial);
      this.partial = "";
    }
  }

  private flushBlock(): void {
    if (!this.block.length) return;
    const joined = this.block.join("\n");
    this.block = [];
    this.blockBytes = 0;
    const colored = tryHighlightBlock(joined, this);
    this.out((colored ?? joined) + "\n");
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

// end index (exclusive) of the escape sequence starting at `start`, or -1
// when it's incomplete and needs the next chunk. Covers CSI (ESC [ … final
// byte @–~), two-byte ESC x, and OSC (ESC ] … BEL or ST ESC\)
function seqEnd(s: string, start: number): number {
  const kind = s[start + 1];
  if (kind === undefined) return -1; // bare trailing ESC — wait for more
  if (kind === "[") {
    for (let j = start + 2; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1;
    }
    return -1;
  }
  if (kind === "]") {
    const bel = s.indexOf("\x07", start + 2);
    const st = s.indexOf("\x1b\\", start + 2);
    if (bel === -1 && st === -1) return -1;
    if (bel === -1) return st + 2;
    if (st === -1) return bel + 1;
    return Math.min(bel + 1, st + 2);
  }
  return Math.min(start + 2, s.length);
}
