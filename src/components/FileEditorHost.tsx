import { useEffect, useRef, useState } from "react";
import { opencode } from "../api";
import FileEditor from "./FileEditor";

// single always-mounted owner of the centered file editor — sidebar tree rows
// and chat tool-call references both open through oc:open-file so two modals
// can never fight over one dirty buffer
export default function FileEditorHost() {
  const [openPath, setOpenPath] = useState<{ path: string; absolute: string } | null>(null);
  const dirtyRef = useRef(false);
  const openRef = useRef(openPath);
  openRef.current = openPath;

  useEffect(() => {
    const onOpen = async (ev: Event) => {
      const d = (ev as CustomEvent<{ path?: string; absolute?: string }>).detail;
      if (!d?.path || d.path === openRef.current?.path) return;
      if (dirtyRef.current && !window.confirm(`${openRef.current!.path}\n\nDiscard unsaved changes?`))
        return;
      let abs = d.absolute ?? "";
      // chat tool calls only know workspace-relative paths — resolve against
      // the server's worktree so saving hits the same file it read
      if (!abs) {
        try {
          const { client } = await opencode();
          const r: any = await client.path.get();
          const wt = String(r.data?.worktree ?? "").replace(/[\\/]+$/, "");
          if (wt) abs = `${wt}/${d.path}`;
        } catch {}
      }
      dirtyRef.current = false;
      setOpenPath({ path: d.path, absolute: abs });
    };
    window.addEventListener("oc:open-file", onOpen);
    return () => window.removeEventListener("oc:open-file", onOpen);
  }, []);

  // expose to ChatPage/__presence for discord status (file > diff > busy > idle)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("oc:file-editor", { detail: { path: openPath?.path ?? "" } }));
  }, [openPath?.path]);

  if (!openPath) return null;
  return (
    <FileEditor
      key={openPath.path}
      path={openPath.path}
      absolute={openPath.absolute}
      onDirty={(v) => (dirtyRef.current = v)}
      onClose={() => {
        dirtyRef.current = false;
        setOpenPath(null);
      }}
    />
  );
}
