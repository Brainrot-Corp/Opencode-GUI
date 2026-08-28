export type FindTarget = "composer" | "chat" | "file";

let last: FindTarget = "chat";

export function getFindTarget(): FindTarget {
  return last;
}
export function setFindTarget(t: FindTarget) {
  last = t;
}

// helper to derive target from an element
export function targetFromElement(el: Element | null): FindTarget | null {
  if (!el) return null;
  if (el.closest(".composer")) return "composer";
  if (el.closest(".fe-stack, .dlg-scrim, .dlg-panel, .filetree, .ft-row")) return "file";
  if (el.closest(".messages, .msg, .msgs-wrap, .main")) return "chat";
  return null;
}
