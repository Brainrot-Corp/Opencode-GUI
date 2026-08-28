import { escPlain } from "./syntax";

export function findMatches(
  text: string,
  query: string,
  matchCase: boolean,
): number[] {
  if (!query) return [];
  const out: number[] = [];
  if (matchCase) {
    for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length))
      out.push(i);
  } else {
    const hay = text.toLowerCase();
    const q = query.toLowerCase();
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push(i);
  }
  return out;
}

// inject find-hit spans into an HTML string without breaking tags.
// splits on tags, only replaces inside text nodes. Uses escaped query so
// "&lt;" etc. match the escaped HTML. Counts occurrences globally to mark active.
export function highlightFindInHtml(
  html: string,
  query: string,
  matchCase: boolean,
  cur: number,
): string {
  if (!query || !html) return html;
  // escaped query as it appears in html text nodes
  const qHtml = escPlain(query);
  if (!qHtml) return html;
  const esc = qHtml.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = matchCase ? "g" : "gi";
  let re: RegExp;
  try {
    re = new RegExp(esc, flags);
  } catch {
    return html;
  }
  let occ = 0;
  const parts = html.split(/(<[^>]*>)/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // tag
    const seg = parts[i];
    if (!seg) continue;
    // reset lastIndex per segment
    re.lastIndex = 0;
    if (!re.test(seg)) continue;
    re.lastIndex = 0;
    parts[i] = seg.replace(re, (m) => {
      const cls = occ === cur ? "find-hit active" : "find-hit";
      occ++;
      return `<span class="${cls}">${m}</span>`;
    });
  }
  return parts.join("");
}
