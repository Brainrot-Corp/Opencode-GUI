// Home workspace helpers.
// Home state is either fresh-boot [""] (server cwd == spawn cwd == home
// when nothing was saved) or the explicit user-home dir after Close All
// ("" alone can't be trusted then: the sidecar's cwd is fixed at spawn).
import { normWorkspace } from "./platform.ts";

export function isHomeOnly(dirs: string[]): boolean {
  return dirs.length === 1 && !(dirs[0] ?? "").trim();
}

// home state: [""] always counts (see above); otherwise the single dir must
// match the resolved user-home path (case rules per OS via normWorkspace).
export function isHome(dirs: string[], home: string): boolean {
  if (dirs.length !== 1) return false;
  const d = (dirs[0] ?? "").trim();
  if (!d) return true;
  const h = (home ?? "").trim();
  return !!h && normWorkspace(d) === normWorkspace(h);
}

export function shouldAutoCreateHome(args: {
  booting: boolean;
  dirs: string[];
  home: string;
  sessionCount: number;
  creating: boolean;
  consumed: boolean;
}): boolean {
  if (args.booting) return false;
  if (args.creating) return false;
  if (args.consumed) return false;
  if (!isHome(args.dirs, args.home)) return false;
  return args.sessionCount === 0;
}
