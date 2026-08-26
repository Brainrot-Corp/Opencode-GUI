import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { newer, releaseVersion } from "../lib/version";

const REPO = "Brainrot-Corp/Opencode-GUI";
// releases attach two portable zips (win10 = noglass build, win11 = default
// glass build) — the running app picks its own flavor
const ZIP = (flavor: string) => `opencode-gui-${flavor}-x64.zip`;
// GitHub's unauthenticated API allows ~60 req/hr — silence repeat checks
const CHECK_COOLDOWN = 60 * 60 * 1000;

export type UpdateInfo = {
  version: string;
  notes: string;
  url: string;
  sha256: string;
};

// silent check on launch (cooldown-cached), manual check + install from the
// Settings drawer. The matching release zip is verified against the GitHub
// asset sha256 before staging; update_install exits the app and the host
// swaps the files on exit.
export function useUpdater() {
  const [ver, setVer] = useState("");
  const [latest, setLatest] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState("");
  const [flavor, setFlavor] = useState("");
  const ranRef = useRef(false);

  useEffect(() => {
    invoke<string>("build_flavor")
      .then(setFlavor)
      .catch(() => setFlavor("win11"));
  }, []);

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
      const asset = (j.assets ?? []).find(
        (a: { name: string }) => a.name === ZIP(flavor),
      );
      const version = releaseVersion(String(j.tag_name ?? ""));
      const digest: string = asset?.digest ?? "";
      let info: UpdateInfo | null = null;
      if (asset && digest.startsWith("sha256:")) {
        const sha256 = digest.slice(7);
        if (newer(version, cur) && sha256) {
          info = {
            version,
            notes: String(j.body ?? ""),
            url: asset.browser_download_url,
            sha256,
          };
        }
      }
      localStorage.setItem("oc.upd", JSON.stringify({ at: now, info }));
      setLatest(info);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [ver, flavor]);

  // one silent check per app launch (SettingsDrawer mounts at startup) —
  // after the build flavor is known
  useEffect(() => {
    if (ranRef.current || !flavor) return;
    ranRef.current = true;
    void check();
  }, [check, flavor]);

  async function install(): Promise<void> {
    if (!latest) return;
    setErr("");
    setDownloading(true);
    try {
      await invoke("update_download", {
        url: latest.url,
        sha256: latest.sha256,
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
