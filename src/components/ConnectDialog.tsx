import { useEffect, useMemo, useRef, useState } from "react";
import Dialog from "./Dialog";
import { useProviderAuth, visiblePrompts } from "../hooks/useProviderAuth";
import { playSound } from "../lib/sounds";
import "../styles/plugins.css";

// /connect — provider auth for the current workspace's server.
// Step 1: filter + pick provider (popular first, TUI order). Step 2: pick
// method + answer its extra prompts (e.g. Azure resource name). Step 3: paste
// API key (PUT /auth/{id} + metadata) or browser OAuth (authorize+inputs →
// code → callback).
export default function ConnectDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected?: () => void;
}) {
  const { dir, items, loading, busy, error, refresh, saveKey, beginOAuth, submitCode, signOut } =
    useProviderAuth();
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState("");
  const [methodIdx, setMethodIdx] = useState(0);
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  // extra per-method prompt answers (keyed by prompt key), reset on pick/method change
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState<{ url: string; method: string; instructions: string } | null>(null);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selId) detailRef.current?.scrollIntoView({ block: "nearest" });
  }, [selId]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (needle
        ? items.filter((p) => `${p.id} ${p.label}`.toLowerCase().includes(needle))
        : items
      ).slice(0, 200),
    [items, needle],
  );
  const sel = items.find((p) => p.id === selId) ?? null;
  const method = sel?.methods[Math.min(methodIdx, (sel?.methods.length ?? 1) - 1)];
  const isOAuth = method?.type === "oauth";
  const working = busy !== null;
  // visible extra prompts for the picked method (`when` conditionals follow
  // the answers so far, TUI PromptsMethod semantics)
  const prompts = useMemo(() => visiblePrompts(method?.prompts, inputs), [method, inputs]);
  const promptsReady = prompts.every((p) => (inputs[p.key] ?? "").trim() !== "");
  // only visible answers are sent — stale values from hidden conditionals stay out
  const activeInputs = (): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const p of prompts) {
      const v = p.type === "select" ? (inputs[p.key] ?? "") : (inputs[p.key] ?? "").trim();
      if (v) out[p.key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const pick = (id: string) => {
    playSound("click");
    // default to the API-key method when the provider offers both key and
    // browser sign-in (e.g. OpenAI lists OAuth first) — otherwise clicking
    // a provider lands on OAuth and never asks for the key.
    const item = items.find((p) => p.id === id);
    const apiIdx = item?.methods.findIndex((m) => m.type === "api") ?? -1;
    setSelId(id);
    setMethodIdx(apiIdx >= 0 ? apiIdx : 0);
    setKey("");
    setCode("");
    setInputs({});
    setOauth(null);
    setErr("");
    setNotice("");
    setDone("");
  };
  const pickMethod = (i: number) => {
    playSound("click");
    setMethodIdx(i);
    setInputs({});
    setOauth(null);
    setErr("");
  };

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : String(e));

  const doSaveKey = async () => {
    if (!sel || working || !key.trim() || !promptsReady) return;
    setErr("");
    setNotice("");
    try {
      await saveKey(sel.id, Math.min(methodIdx, sel.methods.length - 1), key, activeInputs());
      setKey(""); // never keep the secret in state longer than the call
      setDone(sel.label);
      setNotice(`Connected ${sel.label} — models refreshing. Pick one with /models.`);
      playSound("click");
      onConnected?.();
    } catch (e) {
      fail(e);
    }
  };

  const doOAuth = async () => {
    if (!sel || working || !promptsReady) return;
    setErr("");
    setNotice("");
    try {
      const r = await beginOAuth(sel.id, Math.min(methodIdx, sel.methods.length - 1), activeInputs());
      setOauth(r);
      setCode("");
    } catch (e) {
      fail(e);
    }
  };

  const doCode = async () => {
    if (!sel || working || !code.trim()) return;
    setErr("");
    setNotice("");
    try {
      await submitCode(sel.id, Math.min(methodIdx, sel.methods.length - 1), code);
      setCode("");
      setOauth(null);
      setDone(sel.label);
      setNotice(`Connected ${sel.label} — models refreshing. Pick one with /models.`);
      playSound("click");
      onConnected?.();
    } catch (e) {
      fail(e);
    }
  };

  const doLogout = async () => {
    if (!sel || working) return;
    setErr("");
    setNotice("");
    try {
      await signOut(sel.id);
      setNotice(`Signed out ${sel.label}.`);
      playSound("click");
      onConnected?.();
    } catch (e) {
      fail(e);
    }
  };

  const doCopy = (url: string) => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setErr("Could not copy to clipboard"),
    );
  };

  return (
    <Dialog
      title="Connect a provider"
      onClose={onClose}
      wide
      actions={
        <button
          type="button"
          className="icon-btn"
          data-tip="Refresh"
          disabled={loading || working}
          onClick={() => {
            setErr("");
            refresh().catch(fail);
          }}
        >
          <i className={`fa-solid fa-arrows-rotate${loading ? " fa-spin" : ""}`} />
        </button>
      }
    >
      <div className="vc-tip">
        <i className="fa-solid fa-plug" />
        <span>
          {loading
            ? "Loading providers…"
            : `${items.length} provider${items.length === 1 ? "" : "s"} on ${dir || "the local server"}`}
          {needle ? ` · matching “${q}”` : ""}. Keys go to that server&apos;s <span className="mono">auth.json</span> only.
        </span>
      </div>
      <div className="browse-search vc-search">
        <label className="model-search-wrap" style={{ cursor: "text" }}>
          <i className="fa-solid fa-magnifying-glass" />
          <input
            className="model-search"
            placeholder="Filter providers…  e.g. anthropic, openai"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) {
                e.stopPropagation();
                setQ("");
              }
            }}
          />
          {q && (
            <button type="button" className="reset-btn" onClick={() => setQ("")} data-tip="Clear filter">
              <i className="fa-solid fa-xmark" />
            </button>
          )}
        </label>
      </div>
      {(err || error) && <div className="voice-err">{err || error}</div>}
      {notice && (
        <div className="vc-tip">
          <i className="fa-solid fa-circle-info" />
          <span>{notice}</span>
        </div>
      )}
      {loading ? (
        <div className="vc-empty">Loading providers…</div>
      ) : items.length === 0 && !error ? (
        <div className="vc-empty">No providers reported by this server.</div>
      ) : (
        <div className="vc-frame">
          <div className="vc-section">
            <div className="vc-section-head" style={{ cursor: "default" }}>
              <i className="fa-solid fa-server" />
              <span>{dir || "local server"}</span>
              <span className="vc-count">{shown.length}</span>
            </div>
            <div className="vc-list" style={{ maxHeight: 300, overflowY: "auto" }}>
              {shown.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`vc-row hk${p.id === selId ? " sel" : ""}`}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    cursor: "pointer",
                    font: "inherit",
                    color: "inherit",
                    borderColor: p.id === selId ? "var(--accent)" : undefined,
                  }}
                  onClick={() => pick(p.id)}
                >
                  <i
                    className={`fa-solid ${p.id === selId ? "fa-circle-check" : "fa-circle"}`}
                    style={{ color: p.id === selId ? "var(--accent)" : "var(--text-faint)", fontSize: 12 }}
                  />
                  <div className="vc-desc" style={{ minWidth: 0 }}>
                    <div className="vc-name">
                      {p.popular && (
                        <i
                          className="fa-solid fa-star"
                          style={{ color: "var(--accent)", fontSize: 10, marginRight: 4 }}
                        />
                      )}
                      {p.label}
                    </div>
                    <div style={{ color: "var(--text-faint)", fontSize: 10 }} className="mono">
                      {p.id}{p.note ? ` ${p.note}` : ""}
                    </div>
                  </div>
                  <span style={{ color: "var(--text-faint)", fontSize: 10 }}>
                    {p.connected ? "connected · " : ""}
                    {p.methods.some((m) => m.type === "oauth") && p.methods.some((m) => m.type === "api")
                      ? "key · oauth"
                      : p.methods[0]?.type === "oauth"
                        ? "oauth"
                        : "key"}
                  </span>
                </button>
              ))}
              {shown.length === 0 && <div className="vc-empty">No providers match “{q}”.</div>}
            </div>
          </div>
        </div>
      )}
      {sel && (
        <div className="vc-frame" ref={detailRef} style={{ marginTop: 6 }}>
          <div className="vc-section">
            <div className="vc-section-head" style={{ cursor: "default" }}>
              <i className="fa-solid fa-key" />
              <span>{sel.label}</span>
              <span className="vc-count">{sel.methods.length} method{sel.methods.length === 1 ? "" : "s"}</span>
            </div>
            <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
              {sel.methods.length > 1 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {sel.methods.map((m, i) => (
                    <button
                      key={`${m.type}-${i}`}
                      type="button"
                      className={`reset-btn${i === Math.min(methodIdx, sel.methods.length - 1) ? " on" : ""}`}
                      data-tip={m.type === "oauth" ? "Browser sign-in" : "Paste an API key"}
                      onClick={() => pickMethod(i)}
                      style={
                        i === Math.min(methodIdx, sel.methods.length - 1)
                          ? { color: "var(--accent)", borderColor: "var(--accent)" }
                          : undefined
                      }
                    >
                      <i className={`fa-solid ${m.type === "oauth" ? "fa-globe" : "fa-key"}`} />
                      {m.label || (m.type === "oauth" ? "OAuth" : "API key")}
                    </button>
                  ))}
                </div>
              )}
              {/* extra per-method prompts (TUI PromptsMethod) — answered before
                  the key is saved or the browser flow starts */}
              {(!isOAuth || !oauth) && prompts.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {prompts.map((p) =>
                    p.type === "select" ? (
                      <div key={p.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{p.message}</span>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {p.options.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              className={`reset-btn${inputs[p.key] === o.value ? " on" : ""}`}
                              data-tip={o.hint || o.label}
                              onClick={() => {
                                playSound("click");
                                setInputs((prev) => ({ ...prev, [p.key]: o.value }));
                              }}
                              style={
                                inputs[p.key] === o.value
                                  ? { color: "var(--accent)", borderColor: "var(--accent)" }
                                  : undefined
                              }
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <label key={p.key} className="model-search-wrap" style={{ cursor: "text" }}>
                        <i className="fa-solid fa-pen" />
                        <input
                          className="model-search"
                          placeholder={p.placeholder || p.message}
                          value={inputs[p.key] ?? ""}
                          onChange={(e) => setInputs((prev) => ({ ...prev, [p.key]: e.target.value }))}
                          data-tip={p.message}
                        />
                      </label>
                    ),
                  )}
                </div>
              )}
              {!isOAuth ? (
                <label className="model-search-wrap" style={{ cursor: "text" }}>
                  <i className="fa-solid fa-lock" />
                  <input
                    className="model-search"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`Paste your ${sel.label} API key…`}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doSaveKey();
                    }}
                  />
                  <button
                    type="button"
                    className="reset-btn"
                    disabled={!key.trim() || working || !promptsReady}
                    onClick={() => void doSaveKey()}
                    data-tip={
                      !promptsReady ? "Answer the fields above first" : busy === sel.id ? "Saving…" : "Save key"
                    }
                  >
                    <i className={`fa-solid ${busy === sel.id ? "fa-spinner fa-spin" : "fa-arrow-right"}`} />
                  </button>
                </label>
              ) : !oauth ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="reset-btn"
                    disabled={working || !promptsReady}
                    onClick={() => void doOAuth()}
                    data-tip={
                      !promptsReady
                        ? "Answer the fields above first"
                        : `Sign in to ${sel.label} in the browser`
                    }
                  >
                    <i className={`fa-solid ${busy === sel.id ? "fa-spinner fa-spin" : "fa-globe"}`} />
                    {busy === sel.id ? "Working…" : `Sign in with ${sel.label}`}
                  </button>
                  <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{method?.label || "Opens your browser"}</span>
                </div>
              ) : (
                <div>
                  <div style={{ marginBottom: 4, fontSize: 11 }}>
                    {oauth.method === "auto" ? "Waiting for browser sign-in… " : "Browser opened — "}
                    <button type="button" className="reset-btn" onClick={() => doCopy(oauth.url)} data-tip="Copy sign-in link">
                      <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} />
                      {copied ? "Copied" : "Copy link"}
                    </button>
                  </div>
                  {oauth.instructions && (
                    <div style={{ color: "var(--text-faint)", fontSize: 11, marginBottom: 6 }}>{oauth.instructions}</div>
                  )}
                  <div className="mono" style={{ fontSize: 10, overflowWrap: "anywhere", color: "var(--text-faint)" }}>
                    {oauth.url}
                  </div>
                  {oauth.method === "auto" ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button
                        type="button"
                        className="reset-btn"
                        onClick={() => {
                          setOauth(null);
                          setDone(sel.label);
                          setNotice(`Finished ${sel.label} in the browser? Pick a model with /models.`);
                          onConnected?.();
                        }}
                        data-tip="I finished signing in"
                      >
                        <i className="fa-solid fa-check" />
                        Done
                      </button>
                    </div>
                  ) : (
                    <label className="model-search-wrap" style={{ cursor: "text", marginTop: 6 }}>
                      <i className="fa-solid fa-key" />
                      <input
                        className="model-search"
                        placeholder="Paste the authorization code…"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void doCode();
                        }}
                      />
                      <button
                        type="button"
                        className="reset-btn"
                        disabled={!code.trim() || working}
                        onClick={() => void doCode()}
                        data-tip="Submit code"
                      >
                        <i className={`fa-solid ${busy === sel.id ? "fa-spinner fa-spin" : "fa-arrow-right"}`} />
                      </button>
                    </label>
                  )}
                </div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="reset-btn"
                  disabled={working}
                  onClick={() => void doLogout()}
                  data-tip={`Remove saved credentials for ${sel.label}`}
                >
                  <i className="fa-solid fa-right-from-bracket" />
                  Sign out
                </button>
                {done === sel.label && (
                  <span style={{ color: "var(--accent)", fontSize: 11, alignSelf: "center" }}>
                    <i className="fa-solid fa-check" /> saved
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <p className="cmd-note">
        Same flow as the TUI <span className="mono">/connect</span>: keys land in that server&apos;s{" "}
        <span className="mono">auth.json</span>. Then run <span className="mono">/models</span> to pick a model.
      </p>
    </Dialog>
  );
}
