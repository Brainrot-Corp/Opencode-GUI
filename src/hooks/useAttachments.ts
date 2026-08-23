import { useState } from "react";
import type { Attachment } from "../types";
import { MAX_FILE, mimeFor, prettySize, readAttachment } from "../lib/attachments";

// staged attachment pipeline: file input / paste / drag-drop → progress →
// dedupe by content hash. Capabilities are ADVISORY only — verified lying
// for Zen free models (reports no-image while ox alpha ingests PNGs fine),
// so nothing here is hard-blocked; unsupported types surface as a provider
// error on send.
export function useAttachments() {
  const [files, setFiles] = useState<Attachment[]>([]);
  // inline warning line (size/dup/read rejects)
  const [note, setNote] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const addFiles = (list: FileList | File[] | null | undefined) => {
    if (!list?.length) return;
    setNote("");
    for (const f of Array.from(list)) {
      const mime = mimeFor(f);
      if (f.size > MAX_FILE) {
        setNote(`${f.name}: over the ${prettySize(MAX_FILE)} limit`);
        continue;
      }
      const id = crypto.randomUUID();
      setFiles((prev) => [
        ...prev,
        { id, mime, filename: f.name, url: "", size: f.size, status: "reading", progress: 0 },
      ]);
      void readAttachment(f, (p) =>
        setFiles((prev) => prev.map((x) => (x.id === id ? { ...x, progress: p } : x))),
      ).then((res) => {
        if (!res) {
          setFiles((prev) => prev.filter((x) => x.id !== id));
          setNote(`${f.name}: could not be read`);
          return;
        }
        setFiles((prev) => {
          // same bytes already staged in this draft — drop the newcomer
          if (prev.some((x) => x.id !== id && x.hash === res.hash)) {
            setNote(`${f.name}: already attached`);
            return prev.filter((x) => x.id !== id);
          }
          return prev.map((x) =>
            x.id === id ? { ...x, status: "ready" as const, progress: 1, url: res.url, hash: res.hash } : x,
          );
        });
      });
    }
  };

  const removeFile = (id: string) => setFiles((prev) => prev.filter((x) => x.id !== id));

  const clearFiles = () => setFiles([]);

  const readyFiles = () => files.filter((f) => f.status === "ready");

  return { files, note, setNote, dragOver, setDragOver, addFiles, removeFile, clearFiles, readyFiles };
}
