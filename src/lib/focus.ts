// focus liveness — single source for "can this element still own keyboard?"
// closing the terminal (dock stays mounted, height 0) or the last session
// (composer unmounts) can strand activeElement on a hidden/detached node:
// nothing looks focused and window keydown stops firing. These helpers let
// every focus read/write validate liveness first, so shortcuts keep working
// even when nothing visible owns focus.
// ponytail: two tiny fns, no deps, used by 4 files to avoid hidden-focus drift

/** True when el is attached, enabled and visibly focusable (not in a closed dock). */
export function isLiveFocusTarget(el: Element | null | undefined): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (!document.contains(el)) return false;
  if ((el as HTMLInputElement).disabled) return false;
  if (el.closest?.(".term-dock.closed, [hidden]")) return false;
  return true;
}

/** Park keyboard on body when it is trapped on a dead/hidden element (or lost
 * entirely). No-op when a live element already owns focus — this never steals
 * focus, it only guarantees window keydown keeps firing. */
export function releaseTrapFocus(): boolean {
  try {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && isLiveFocusTarget(ae)) return false;
    if (ae === document.body && document.hasFocus()) return false;
    if (!document.body.hasAttribute("tabindex")) document.body.setAttribute("tabindex", "-1");
    document.body.focus({ preventScroll: true } as any);
    window.focus();
    return true;
  } catch {
    return false;
  }
}
