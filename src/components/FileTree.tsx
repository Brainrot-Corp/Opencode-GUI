import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { opencode } from "../api";
import { useContextMenu } from "../hooks/useContextMenu";
import { clipboardWrite } from "../lib/clipboard";
import "../styles/files.css";

type Node = {
  name: string;
  path: string;
  absolute: string;
  type: "file" | "directory";
  ignored: boolean;
};

function FileIcon({ name }: { name: string }) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "fa-file-code",
    tsx: "fa-file-code",
    js: "fa-file-code",
    jsx: "fa-file-code",
    rs: "fa-file-code",
    py: "fa-file-code",
    json: "fa-file-code",
    toml: "fa-file-code",
    css: "fa-file-lines",
    md: "fa-book-open",
    png: "fa-file-image",
    jpg: "fa-file-image",
    ico: "fa-file-image",
    lock: "fa-lock",
  };
  return <i className={`fa-solid ${map[ext] ?? "fa-file-lines"}`} />;
}

export default function FileTree() {
  // fetched children per directory path ("" = workspace root)
  const [kids, setKids] = useState<Map<string, Node[]>>(new Map());
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [loadingDir, setLoadingDir] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const ctx = (() => { try { return useContextMenu(); } catch { return null; } })();

  function workspaceRootAbs(): string {
    try {
      const raw = localStorage.getItem("oc.settings");
      if (raw) {
        const j = JSON.parse(raw);
        if (typeof j.workspace === "string" && j.workspace) return j.workspace;
      }
    } catch {}
    // fallback: derive from first node's absolute
    const root = kids.get("")?.[0];
    if (root?.absolute && root?.path) {
      const rel = root.path;
      const abs = root.absolute;
      // remove trailing /rel
      if (abs.endsWith(rel.replace(/\//g, "\\")) || abs.endsWith(rel)) {
        return abs.slice(0, abs.length - rel.length).replace(/[\/\\]+$/, "");
      }
      // fallback: parent of absolute
      const idx = Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/"));
      if (idx > 0) {
        // go up one level from root file's parent? Approximate
        return abs.slice(0, idx).replace(/[\/\\]+$/, "");
      }
    }
    return "";
  }
  function parentPath(p: string): string {
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(0, i) : "";
  }
  function parentAbs(node: Node): string {
    const abs = node.absolute;
    const i = Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/"));
    return i >= 0 ? abs.slice(0, i) : abs;
  }
  function joinAbs(base: string, name: string): string {
    if (!base) return name;
    const sep = base.includes("\\") ? "\\" : "/";
    return base.replace(/[\/\\]+$/, "") + sep + name;
  }

  async function load(path: string) {
    setLoadingDir(path);
    try {
      const { client } = await opencode();
      const r = await client.file.list({ query: { path } });
      const nodes = ((r.data ?? []) as Node[]).slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setKids((prev) => new Map(prev).set(path, nodes));
      setError("");
    } catch (e) {
      setError(String(e));
    }
    setLoadingDir("");
  }

  useEffect(() => {
    load("");
  }, []);

  function toggleDir(n: Node) {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(n.path)) next.delete(n.path);
      else {
        next.add(n.path);
        if (!kids.has(n.path)) load(n.path);
      }
      return next;
    });
  }

  function openFile(n: Node) {
    window.dispatchEvent(
      new CustomEvent("oc:open-file", { detail: { path: n.path, absolute: n.absolute } }),
    );
  }

  async function doCreate(isDir: boolean, base: Node | null) {
    const name = window.prompt(isDir ? "New folder name:" : "New file name:");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (trimmed.includes("/") || trimmed.includes("\\")) { setError("Name cannot contain path separators"); return; }
    const basePath = base ? base.path : "";
    const baseAbs = base ? base.absolute : workspaceRootAbs();
    if (!baseAbs) { setError("Cannot determine workspace root — open a workspace first"); return; }
    const abs = joinAbs(baseAbs, trimmed);
    try {
      await invoke("file_create", { path: abs, is_dir: isDir });
      await load(basePath);
      if (base && !openDirs.has(base.path)) setOpenDirs((prev) => new Set(prev).add(base.path));
    } catch (e) { setError(String(e)); }
  }

  async function doDelete(n: Node) {
    if (!window.confirm(`Delete ${n.type} "${n.name}"?\n${n.path}\n\nThis cannot be undone.`)) return;
    try {
      await invoke("file_delete", { path: n.absolute });
      await load(parentPath(n.path));
    } catch (e) { setError(String(e)); }
  }

  async function doDuplicate(n: Node) {
    try {
      await invoke<string>("file_duplicate", { path: n.absolute });
      await load(parentPath(n.path));
    } catch (e) { setError(String(e)); }
  }

  async function doRename(n: Node) {
    const newName = renameVal.trim();
    if (!newName || newName === n.name) { setRenaming(null); return; }
    if (newName.includes("/") || newName.includes("\\")) { setError("Name cannot contain separators"); return; }
    const pPath = parentPath(n.path);
    const pAbs = parentAbs(n);
    const newAbs = joinAbs(pAbs, newName);
    try {
      await invoke("file_rename", { from: n.absolute, to: newAbs });
      setRenaming(null);
      await load(pPath);
    } catch (e) { setError(String(e)); }
  }

  function showFileMenu(e: React.MouseEvent, n: Node) {
    e.preventDefault();
    if (!ctx) return;
    const isDir = n.type === "directory";
    ctx.show(e.clientX, e.clientY, [
      ...(isDir ? [] : [{ label: "Open", icon: "fa-arrow-up-right-from-square", action: () => openFile(n) } as any]),
      { label: "Reveal in Explorer", icon: "fa-folder-open", action: () => void invoke("file_reveal", { path: n.absolute }).catch((er)=> setError(String(er))) },
      { label: "Open With Default App", icon: "fa-up-right-from-square", action: () => void invoke("file_open", { path: n.absolute }).catch((er)=> setError(String(er))) },
      { separator: true },
      { label: "Copy Path", icon: "fa-link", action: () => void clipboardWrite(n.absolute) },
      { label: "Copy Relative Path", icon: "fa-code", action: () => void clipboardWrite(n.path) },
      ...(isDir ? [] : [{ label: "Copy Content", icon: "fa-copy", action: async () => {
        try { const { client } = await opencode(); const r:any = await client.file.read({ query: { path: n.path }}); const txt = typeof r.data === "string" ? r.data : (r.data?.content ?? ""); await clipboardWrite(String(txt)); } catch (er) { setError(String(er)); }
      }} as any]),
      { separator: true },
      ...(isDir ? [
        { label: "New File", icon: "fa-file-circle-plus", action: () => void doCreate(false, n) },
        { label: "New Folder", icon: "fa-folder-plus", action: () => void doCreate(true, n) },
      ] : []),
      { label: "Duplicate", icon: "fa-copy", action: () => void doDuplicate(n) },
      { label: "Rename", icon: "fa-pen", action: () => { setRenaming(n.path); setRenameVal(n.name); setTimeout(()=> document.querySelector<HTMLInputElement>(`input[data-ft-rename="${n.path}"]`)?.select(), 0); } },
      { separator: true },
      { label: isDir ? "Delete Folder" : "Delete File", icon: "fa-trash-can", danger: true, action: () => void doDelete(n) },
    ]);
  }

  function showBackgroundMenu(e: React.MouseEvent) {
    // only when clicking on empty area, not on a row
    if ((e.target as HTMLElement).closest(".ft-row")) return;
    e.preventDefault();
    if (!ctx) return;
    ctx.show(e.clientX, e.clientY, [
      { label: "New File", icon: "fa-file-circle-plus", action: () => void doCreate(false, null) },
      { label: "New Folder", icon: "fa-folder-plus", action: () => void doCreate(true, null) },
      { separator: true },
      { label: "Refresh", icon: "fa-arrows-rotate", action: () => void load("") },
      { label: "Reveal Workspace in Explorer", icon: "fa-folder-open", action: () => {
        const root = workspaceRootAbs();
        if (root) void invoke("file_reveal", { path: root }).catch((er)=> setError(String(er)));
        else setError("No workspace open");
      }},
      { label: "Copy Workspace Path", icon: "fa-link", action: () => {
        const root = workspaceRootAbs();
        if (root) void clipboardWrite(root);
      }},
    ]);
  }

  function renderNodes(nodes: Node[], depth: number): React.ReactNode {
    return nodes.map((n) => {
      if (renaming === n.path) {
        return (
          <div key={n.path} className="ft-row file" style={{ paddingLeft: 6 + depth * 14 + 16, gap: 6 }}>
            <FileIcon name={n.name} />
            <input
              data-ft-rename={n.path}
              className="ft-rename"
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void doRename(n); }
                else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
              }}
              onBlur={() => void doRename(n)}
              spellCheck={false}
              autoFocus
            />
          </div>
        );
      }
      return n.type === "directory" ? (
        <div key={n.path}>
          <button
            className={`ft-row${n.ignored ? " ignored" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => toggleDir(n)}
            onContextMenu={(e) => showFileMenu(e as any, n)}
          >
            <i className={`fa-solid fa-chevron-${openDirs.has(n.path) ? "down" : "right"} ft-chev`} />
            <i className={`fa-solid ${openDirs.has(n.path) ? "fa-folder-open" : "fa-folder"}`} />
            <span>{n.name}</span>
            {loadingDir === n.path && <i className="fa-solid fa-gear fa-spin-pulse ft-load" />}
          </button>
          {openDirs.has(n.path) && renderNodes(kids.get(n.path) ?? [], depth + 1)}
        </div>
      ) : (
        <button
          key={n.path}
          className={`ft-row file${n.ignored ? " ignored" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 + 16 }}
          onClick={() => openFile(n)}
          onContextMenu={(e) => showFileMenu(e as any, n)}
        >
          <FileIcon name={n.name} />
          <span>{n.name}</span>
        </button>
      );
    });
  }

  return (
    <div className="filetree" onContextMenu={showBackgroundMenu} style={{ minHeight: 60 }}>
      {error && <p className="empty">{error}</p>}
      {!error && kids.get("") === undefined && (
        <>
          <div className="skel-row" />
          <div className="skel-row" style={{ animationDelay: "0.15s", width: "80%" }} />
          <div className="skel-row" style={{ animationDelay: "0.3s", width: "65%" }} />
        </>
      )}
      {kids.get("") && renderNodes(kids.get("")!, 0)}
    </div>
  );
}
