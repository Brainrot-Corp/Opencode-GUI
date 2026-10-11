export type SplitForcedSide = "reinstall" | "delete";

/** Any horizontal direction wins: left (dx<0) forces reinstall, right forces delete. */
export function resolveForcedSide(dx: number): SplitForcedSide | null {
  if (!Number.isFinite(dx) || dx === 0) return null;
  return dx < 0 ? "reinstall" : "delete";
}
