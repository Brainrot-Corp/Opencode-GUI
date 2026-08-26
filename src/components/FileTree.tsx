import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { opencode } from "../api";
import FileEditor from "./FileEditor";
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
  const [openPath, setOpenPath] = useState<{ path: string; absolute: string } | null>(null);
  const [error, setError] = useState("");
  const dirtyRef = useRef(false);

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
    if (openPath?.path === n.path) return;
    if (dirtyRef.current && !window.confirm(`${openPath!.path}\n\nDiscard unsaved changes?`))
      return;
    setOpenPath({ path: n.path, absolute: n.absolute });
  }

  function renderNodes(nodes: Node[], depth: number): React.ReactNode {
    return nodes.map((n) =>
      n.type === "directory" ? (
        <div key={n.path}>
          <button
            className={`ft-row${n.ignored ? " ignored" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => toggleDir(n)}
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
        >
          <FileIcon name={n.name} />
          <span>{n.name}</span>
        </button>
      ),
    );
  }

  return (
    <div className="filetree">
      {error && <p className="empty">{error}</p>}
      {!error && kids.get("") === undefined && (
        <>
          <div className="skel-row" />
          <div className="skel-row" style={{ animationDelay: "0.15s", width: "80%" }} />
          <div className="skel-row" style={{ animationDelay: "0.3s", width: "65%" }} />
        </>
      )}
      {kids.get("") && renderNodes(kids.get("")!, 0)}

      {openPath &&
        createPortal(
          <FileEditor
            key={openPath.path}
            path={openPath.path}
            absolute={openPath.absolute}
            onDirty={(d) => (dirtyRef.current = d)}
            onClose={() => {
              dirtyRef.current = false;
              setOpenPath(null);
            }}
          />,
          document.body,
        )}
    </div>
  );
}
