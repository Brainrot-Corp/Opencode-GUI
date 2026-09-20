import { useState } from "react";
import Dialog from "./Dialog";
import { shortDir } from "./CommandDialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { mdComponents } from "./parts/mdParts";
import { useSkills } from "../hooks/useSkills";
import "../styles/plugins.css";

// /skill — registered skills grouped by this window's workspaces, like /mcp.
// Built-in/global skills repeat per workspace (the server resolves them for
// every directory); the filter box makes that a non-issue.
export function SkillDialog({ onClose }: { onClose: () => void }) {
  const { dirs, loading, refreshLive, refresh } = useSkills();
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const needle = q.trim().toLowerCase();
  const total = dirs.reduce((n, d) => n + d.skills.length, 0);
  const rowKey = (dir: string, name: string) => `${dir}::${name}`;

  const doRefresh = () => {
    if (refreshLive || loading) return;
    setErr("");
    refresh().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const toggleExpand = (key: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <Dialog
      title="Skills"
      onClose={onClose}
      wide
      actions={
        <button
          type="button"
          className="icon-btn"
          data-tip={refreshLive ? "Working…" : "Refresh"}
          disabled={refreshLive || loading}
          onClick={doRefresh}
        >
          <i className={`fa-solid fa-arrows-rotate${refreshLive ? " fa-spin" : ""}`} />
        </button>
      }
    >
      <div className="vc-tip">
        <i className="fa-solid fa-wand-magic-sparkles" />
        <span>
          {loading ? "Loading…" : `${total} skill${total === 1 ? "" : "s"} in this window's workspaces`}
          {needle ? ` · matching “${q}”` : ""}. Type <strong>/name</strong> in the composer to run one.
        </span>
      </div>
      <div className="browse-search vc-search">
        <label className="model-search-wrap" style={{ cursor: "text" }}>
          <i className="fa-solid fa-magnifying-glass" />
          <input
            className="model-search"
            placeholder="Filter skills…  e.g. review, commit"
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
      {err && <div className="voice-err">{err}</div>}
      {loading ? (
        <div className="vc-empty">Loading skills…</div>
      ) : dirs.length === 0 ? (
        <div className="vc-empty">No workspace loaded in this window.</div>
      ) : (
        <div className="vc-frame">
          {dirs.map((d) => {
            const shown = needle
              ? d.skills.filter((s) => `${s.name} ${s.description} ${s.template}`.toLowerCase().includes(needle))
              : d.skills;
            if (needle && shown.length === 0 && !d.error) return null;
            return (
              <div key={d.dir || "__EMPTY__"} className="vc-section">
                <div className="vc-section-head" data-tip={d.dir || "server cwd"} style={{ cursor: "default" }}>
                  <i className="fa-solid fa-folder" />
                  <span>{shortDir(d.dir)}</span>
                  <span className="vc-count">{d.pending ? "…" : shown.length}</span>
                </div>
                {d.pending ? (
                  <div className="vc-empty">Loading…</div>
                ) : d.error ? (
                  <div className="vc-empty">{d.error}</div>
                ) : shown.length === 0 ? (
                  <div className="vc-empty">No skills in this workspace.</div>
                ) : (
                  <div className="vc-list">
                    {shown.map((s) => {
                      const key = rowKey(d.dir, s.name);
                      const isOpen = expanded.has(key);
                      return (
                        <div key={s.name}>
                          <div className="vc-row hk">
                            <i className="fa-solid fa-wand-magic-sparkles" style={{ color: "var(--accent)", fontSize: 12 }} />
                            <div className="vc-desc" style={{ minWidth: 0 }}>
                              <div className="vc-name">{s.name}</div>
                              {s.description && <div style={{ marginTop: 2 }}>{s.description}</div>}
                            </div>
                            <button
                              type="button"
                              className="reset-btn"
                              data-tip={isOpen ? "Hide skill content" : "Show skill content"}
                              onClick={() => toggleExpand(key)}
                            >
                              <i className={`fa-solid fa-chevron-${isOpen ? "up" : "down"}`} />
                            </button>
                          </div>
                          {isOpen && (
                            <div className="skill-body" style={{ padding: "6px 10px 8px 30px" }}>
                              {s.template.trim() ? (
                                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
                                  {s.template}
                                </Markdown>
                              ) : (
                                <div style={{ color: "var(--text-faint)" }}>No markdown body.</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!loading && <p className="cmd-note">Skills are markdown files (<span className="mono">SKILL.md</span>) in <span className="mono">.opencode/skills/</span> per workspace or <span className="mono">~/.config/opencode/skills/</span> globally — new files need a sidecar restart. Each skill is also available as a <span className="mono">/name</span> command.</p>}
    </Dialog>
  );
}
