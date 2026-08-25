import { useEffect, useState } from "react";
import type { AppSettings } from "../hooks/useSettings";
import { clearTuyaCache, confReady, testCreds } from "../lib/tuya";

const REGIONS: [string, string][] = [
  ["us", "Americas"],
  ["eu", "Europe"],
  ["cn", "China"],
  ["in", "India"],
];

// Tuya cloud credentials for voice light control — keys come from a free
// project at iot.tuya.com after linking the Smart Life app account
export default function TuyaSettings({
  open,
  settings,
  update,
}: {
  open: boolean;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const tuya = settings.tuya;
  const set = (patch: Partial<typeof tuya>) => update({ tuya: { ...tuya, ...patch } });
  const [found, setFound] = useState<string[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // stale device cache when the credentials change
  useEffect(() => {
    if (open) clearTuyaCache();
  }, [open, tuya.clientId, tuya.secret, tuya.uid, tuya.region]);

  async function find() {
    setErr("");
    setFound(null);
    setBusy(true);
    try {
      setFound(await testCreds(tuya));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sound-box">
      <div className="sound-box-head">
        <i className="fa-solid fa-lightbulb setting-icon" />
        <span>Lights</span>
        <span className="mono-hint">
          {confReady(tuya) ? (err ? "error — see below" : found ? `${found.length} light(s)` : "ready") : "not configured"}
        </span>
      </div>

      <div className="setting-row" style={{ borderTop: "none", paddingBottom: 0 }}>
        <div className="setting-info">
          <i className="fa-solid fa-key setting-icon" />
          <div>
            <div className="setting-name">Tuya Cloud project</div>
            <div className="setting-desc">
              Create a free project at iot.tuya.com, link your Smart Life account under
              Devices, then paste its Access ID / Secret and your account UID here
            </div>
          </div>
        </div>
      </div>

      <div className="tuya-fields">
        <input
          className="tuya-in"
          placeholder="Access ID (client id)"
          value={tuya.clientId}
          onChange={(e) => set({ clientId: e.target.value.trim() })}
          spellCheck={false}
        />
        <input
          className="tuya-in"
          type="password"
          placeholder="Access Secret"
          value={tuya.secret}
          onChange={(e) => set({ secret: e.target.value.trim() })}
          spellCheck={false}
        />
        <input
          className="tuya-in"
          placeholder="App account UID (Linked Accounts page)"
          value={tuya.uid}
          onChange={(e) => set({ uid: e.target.value.trim() })}
          spellCheck={false}
        />
        <div className="seg-row" role="radiogroup" aria-label="Region">
          {REGIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={tuya.region === id}
              className={`seg${tuya.region === id ? " on" : ""}`}
              onClick={() => set({ region: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="color-controls">
          <button type="button" className="reset-btn" disabled={!confReady(tuya) || busy} onClick={() => void find()}>
            <i className="fa-solid fa-magnifying-glass" />
            {busy ? "Checking…" : "Find bulbs"}
          </button>
        </div>
      </div>

      {err && <div className="voice-err">{err}</div>}
      {found && !err && (
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-circle-check setting-icon" />
            <div>
              <div className="setting-name">Linked — say things like</div>
              <div className="setting-desc mono-hint">
                "{found[0] ?? "desk lamp"} on" · dim the lights to fifty percent · make it warm · turn it blue
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
