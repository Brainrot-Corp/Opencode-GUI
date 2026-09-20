// "User has answered your questions: "q"="a", ... . You can now continue ..."
// quoted-pair extraction — shared by the MessageList answered-summary card
// and ToolBlock's question-tool answer fallback.
// The quoted-pairs regex below was duplicated verbatim in both files; this
// is the single implementation. Two gates exist because the old copies
// differed: MessageList's card only fires when the text STARTS with the
// phrase, ToolBlock's fallback matched it anywhere in the tool output.
export function summaryPairs(out: string): { q: string; a: string }[] | null {
  if (!out.trim().includes("User has answered your questions:")) return null;
  const pairs: { q: string; a: string }[] = [];
  const re = /"([^"]+)"\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) pairs.push({ q: m[1], a: m[2] });
  return pairs.length ? pairs : null;
}

// stricter prefix gate used for synthetic text parts — a reply that merely
// quotes the phrase mid-sentence must stay markdown, not become the card
export function parseAnsweredSummary(text: string): { q: string; a: string }[] | null {
  if (!text.trim().startsWith("User has answered your questions:")) return null;
  return summaryPairs(text);
}
