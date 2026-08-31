// Deduplicate overlapping Whisper results so words aren't repeated.
// Rolling buffer is re-transcribed every 300-1000ms with large overlap; the
// raw texts share a common prefix. We emit only the new suffix.

function words(s: string): string[] {
  return s.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// longest suffix of prev that equals prefix of next (word-level)
export function wordOverlap(prev: string, next: string): number {
  const a = words(prev);
  const b = words(next);
  const max = Math.min(a.length, b.length);
  for (let k = max; k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (a[a.length - k + i] !== b[i]) { ok = false; break; }
    }
    if (ok) return k;
  }
  return 0;
}

export function dedupOverlap(prev: string, next: string): string {
  if (!prev) return next.trim();
  if (!next.trim()) return "";
  // fast path: next starts with prev (char-level)
  const pn = prev.trim();
  const nn = next.trim();
  if (nn.toLowerCase().startsWith(pn.toLowerCase())) {
    const suffix = nn.slice(pn.length).trim();
    // if suffix is just punctuation residue, ignore
    if (!suffix) return "";
    return suffix;
  }
  const k = wordOverlap(prev, next);
  if (k === 0) {
    // no overlap — could be correction; return whole next but caller
    // should treat as replacement, not append. We return next for
    // replace-mode consumers; append-mode will handle via word count.
    return next.trim();
  }
  const b = nn.split(/\s+/);
  return b.slice(k).join(" ").trim();
}

// Cumulative emitter: keeps lastRaw and cumulative displayed.
export class DedupEmitter {
  lastRaw = "";
  cumulative = "";
  // returns delta suffix and updates state; also returns new cumulative
  push(raw: string): { delta: string; cumulative: string; isNew: boolean } {
    const next = raw.trim();
    if (!next) return { delta: "", cumulative: this.cumulative, isNew: false };
    if (!this.lastRaw) {
      this.lastRaw = next;
      this.cumulative = next;
      return { delta: next, cumulative: next, isNew: true };
    }
    const k = wordOverlap(this.lastRaw, next);
    const delta = dedupOverlap(this.lastRaw, next);
    if (!delta) {
      this.lastRaw = next;
      return { delta: "", cumulative: this.cumulative, isNew: false };
    }
    // no word overlap and not a simple prefix extension — whisper revised
    // the whole buffer (correction). Replace cumulative instead of appending
    // to avoid duplicating the prefix ("hello world" + "hello word ..." =>
    // don't get "hello world hello word ...").
    if (k === 0 && delta === next) {
      this.lastRaw = next;
      this.cumulative = next;
      return { delta: next, cumulative: next, isNew: true };
    }
    this.lastRaw = next;
    this.cumulative = this.cumulative ? `${this.cumulative} ${delta}` : delta;
    return { delta, cumulative: this.cumulative, isNew: true };
  }
  reset() {
    this.lastRaw = "";
    this.cumulative = "";
  }
}
