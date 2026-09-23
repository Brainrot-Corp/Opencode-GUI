// Home-workspace wiring.
// Resolves the explicit user home dir (exact via Rust, not the sidecar's
// spawn-fixed cwd) and auto-creates one session when the home workspace
// settles empty (fresh boot + after Close All).
// Kept out of useOpencode/ChatPage (both at/over the file-size budget).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getAllWorkspaces } from "../lib/workspace";
import { isHome, shouldAutoCreateHome } from "../lib/homeWorkspace";

function readDirs(): string[] {
  try {
    return getAllWorkspaces();
  } catch {
    return [""];
  }
}

export function useHomeWorkspace(opts: {
  booting: boolean;
  sessionCount: number;
  newSession: (dir?: string) => Promise<string>;
}): { isHome: boolean; homePath: string; createDir: string } {
  const { booting, sessionCount, newSession } = opts;
  const [dirs, setDirs] = useState<string[]>(readDirs);
  const [homePath, setHomePath] = useState("");
  const creatingRef = useRef(false);
  const consumedRef = useRef(false);
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;

  useEffect(() => {
    const sync = () => setDirs(readDirs());
    window.addEventListener("oc:workspaces-changed", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("oc:workspaces-changed", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  // explicit user home — exact, unlike the server-cwd probe (stale spawn cwd)
  useEffect(() => {
    let dead = false;
    invoke<string>("user_home")
      .then((h) => {
        if (!dead && h && h.trim()) setHomePath(h.trim());
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);

  const home = isHome(dirs, homePath);
  // dir new sessions belong in while home: "" (fresh boot) or explicit home
  const createDir = dirs.length === 1 ? (dirs[0] ?? "") : "";

  // leaving the empty-home episode (sessions arrived or dirs changed away)
  // re-arms auto-create for the next time home settles empty.
  useEffect(() => {
    if (!home || sessionCount > 0) consumedRef.current = false;
  }, [home, sessionCount]);

  // empty home → create one session, once per episode. Failures stay
  // consumed (no retry spin); the user can still press New manually, which
  // re-arms via the effect above once it succeeds.
  useEffect(() => {
    if (
      !shouldAutoCreateHome({
        booting,
        dirs,
        home: homePath,
        sessionCount,
        creating: creatingRef.current,
        consumed: consumedRef.current,
      })
    )
      return;
    consumedRef.current = true;
    creatingRef.current = true;
    newSessionRef
      .current(createDir)
      .catch(() => {})
      .finally(() => {
        creatingRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting, dirs, homePath, sessionCount, home, createDir]);

  return { isHome: home, homePath, createDir };
}
