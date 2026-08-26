import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { newer, releaseVersion } from "../lib/version";

const REPO = "Brainrot-Corp/Opencode-GUI";
// releases attach the two portable exes directly (gui + opencode sidecar) —
// both must be present, each verified against its GitHub asset sha256
const ASSETS = ["opencode-gui.exe", "opencode.exe"];
// GitHub's unauthenticated API allows ~60 req/hr — silence repeat checks
const CHECK_COOLDOWN = 60 * 60 * 1000;

export type UpdateAsset = { name: string; url: string; sha256: string };

export type UpdateInfo = {
  version: string;
  notes: string;
  assets: UpdateAsset[];
};

// silent check on launch (cooldown-cached), manual check + install from the
// Settings drawer. The release exes are verified against the GitHub asset
// sha256 digests before staging; update_install exits the app and the host
// swaps the files on exit.
export function useUpdater() {
  const [ver, setVer] = useState("");
  const [latest, setLatest] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState("");
  const ranRef = useRef(false);

  const check = useCallback(async (): Promise<void> => {
    setBusy(true);
    setErr("");
    try {
      const cur = ver || (await getVersion().catch(() => ""));
      if (cur) setVer(cur);
      const cached = localStorage.getItem("oc.upd");
      const now = Date.now();
      if (cached) {
        try {
          const c = JSON.parse(cached) as { at: number; info: UpdateInfo | null };
          if (now - c.at < CHECK_COOLDOWN) {
            setLatest(c.info);
            return;
          }
        } catch {
          /* stale/corrupt cache — re-check */
        }
      }
      const r = await invoke<{ status: number; body: string }>("http_json", {
        method: "GET",
        url: `https://api.github.com/repos/${REPO}/releases/latest`,
        headers: { "User-Agent": "opencode-gui" },
        body: null,
      });
      const j = JSON.parse(r.body);
      const byName = new Map<string, { digest?: string; browser_download_url: string }>(
        (j.assets ?? []).map((a: { name: string; digest?: string; browser_download_url: string }) => [
          a.name,
          a,
        ]),
      );
      const version = releaseVersion(String(j.tag_name ?? ""));
      const assets: UpdateAsset[] = [];
      for (const name of ASSETS) {
        const a = byName.get(name);
        const digest: string = a?.digest ?? "";
        if (!a || !digest.startsWith("sha256:")) break;
        assets.push({ name, url: a.browser_download_url, sha256: digest.slice(7) });
      }
      const info =
        assets.length === ASSETS.length && newer(version, cur)
          ? { version, notes: String(j.body ?? ""), assets }
          : null;
      localStorage.setItem("oc.upd", JSON.stringify({ at: now, info }));
      setLatest(info);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [ver]);

  // one silent check per app launch (SettingsDrawer mounts at startup)
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    void check();
  }, [check]);

  async function install(): Promise<void> {
    if (!latest) return;
    setErr("");
    setDownloading(true);
    try {
      await invoke("update_download", {
        assets: latest.assets,
        version: latest.version,
      });
      await invoke("update_install", {});
      // app is exiting — the swap + relaunch happens host-side
    } catch (e) {
      setErr(String(e));
      setDownloading(false);
    }
  }

  return { ver, latest, busy, downloading, err, check, install };
}
