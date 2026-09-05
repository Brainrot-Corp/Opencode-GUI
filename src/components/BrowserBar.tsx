import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "../lib/i18n";
import "../styles/browser.css";

type NavState = { url: string; canBack: boolean; canFwd: boolean };

export const BROWSER_BAR_H = 34;

// browser chrome strip rendered by the main webview while the child webview
// shows remote content below it — back/forward/reload/URL/open-external and
// the return-to-app button. `top` is the child webview's y; the strip paints
// in the band directly above it so the webview never covers it
export default function BrowserBar({ top, onClose }: { top: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [nav, setNav] = useState<NavState>({ url: "", canBack: false, canFwd: false });
  // null = show the live url; a string = user is editing the field
  const [edit, setEdit] = useState<string | null>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    listen<NavState>("browser://nav", (e) => {
      setNav(e.payload);
      setEdit(null);
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  const go = () => {
    const v = (edit ?? "").trim();
    if (!v) return;
    const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    invoke("browser_navigate", { url }).catch(() => {});
    setEdit(null);
  };

  return (
    <div className="browser-bar" style={{ top: top - BROWSER_BAR_H }}>
      <button className="icon-btn" data-tip={t("browser.back")} disabled={!nav.canBack}
        onClick={() => invoke("browser_back")}>
        <i className="fa-solid fa-arrow-left" />
      </button>
      <button className="icon-btn" data-tip={t("browser.forward")} disabled={!nav.canFwd}
        onClick={() => invoke("browser_forward")}>
        <i className="fa-solid fa-arrow-right" />
      </button>
      <button className="icon-btn" data-tip={t("browser.reload")} onClick={() => invoke("browser_reload")}>
        <i className="fa-solid fa-rotate-right" />
      </button>
      <input
        className="browser-url mono"
        value={edit ?? nav.url}
        placeholder={t("browser.urlPlaceholder")}
        spellCheck={false}
        onChange={(e) => setEdit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button className="icon-btn" data-tip={t("browser.openExternal")}
        onClick={() => nav.url && invoke("open_external", { url: nav.url })}>
        <i className="fa-solid fa-up-right-from-square" />
      </button>
      <button
        className="icon-btn browser-home"
        data-tip={t("browser.return")}
        onClick={() => {
          invoke("browser_close");
          onClose();
        }}
      >
        <i className="fa-solid fa-house" />
      </button>
    </div>
  );
}
