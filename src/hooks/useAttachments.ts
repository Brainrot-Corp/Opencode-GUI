import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../types";
import { MAX_FILE, mimeFor, prettySize, readAttachment } from "../lib/attachments";

// staged attachment pipeline: file input / paste / drag-drop → progress →
// dedupe by content hash. Capabilities are ADVISORY only — verified lying
// for Zen free models (reports no-image while ox alpha ingests PNGs fine),
// so nothing here is hard-blocked; unsupported types surface as a provider
// error on send.
// ponytail: per-session in-memory staging (data URLs too big for localStorage quota); cleared on send/delete, lost on reload
const fileCache = new Map<string, Attachment[]>();
const noteCache = new Map<string, string>();

export function clearAttachmentDraft(sid: string) {
  if (!sid) return;
  fileCache.delete(sid);
  noteCache.delete(sid);
}

export function useAttachments(sessionId?: string) {
  const [files, setFiles] = useState<Attachment[]>(() => (sessionId ? (fileCache.get(sessionId) ?? []) : []));
  // inline warning line (size/dup/read rejects)
  const [note, setNoteState] = useState(() => (sessionId ? (noteCache.get(sessionId) ?? "") : ""));
  const [dragOver, setDragOver] = useState(false);

  const sidRef = useRef(sessionId);
  const filesRef = useRef(files);
  filesRef.current = files;
  const noteRef = useRef(note);
  noteRef.current = note;

  // keep cache in sync for the current session
  useEffect(() => {
    const sid = sidRef.current;
    if (!sid) return;
    if (files.length) fileCache.set(sid, files);
    else fileCache.delete(sid);
  }, [files]);
  useEffect(() => {
    const sid = sidRef.current;
    if (!sid) return;
    if (note) noteCache.set(sid, note);
    else noteCache.delete(sid);
  }, [note]);

  // switch session: stash current, restore target (mirrors lib/drafts text behavior)
  useEffect(() => {
    if (sessionId === sidRef.current) return;
    const prev = sidRef.current;
    if (prev) {
      const cur = filesRef.current;
      if (cur.length) fileCache.set(prev, cur);
      else fileCache.delete(prev);
      const n = noteRef.current;
      if (n) noteCache.set(prev, n);
      else noteCache.delete(prev);
    }
    sidRef.current = sessionId;
    // preserve boot-staged files: typed/pasted while sessionId was empty
    // and the new session has no saved draft → keep current input
    if (!prev && filesRef.current.length > 0 && !(sessionId && fileCache.get(sessionId)?.length)) {
      if (sessionId) fileCache.set(sessionId, filesRef.current);
    } else {
      setFiles(sessionId ? (fileCache.get(sessionId) ?? []) : []);
      setNoteState(sessionId ? (noteCache.get(sessionId) ?? "") : "");
    }
  }, [sessionId]);

  const setNote = (v: string) => setNoteState(v);

  const addFiles = (list: FileList | File[] | null | undefined) => {
    if (!list?.length) return;
    const owner = sidRef.current;
    setNoteState("");
    if (owner) noteCache.delete(owner);
    for (const f of Array.from(list)) {
      const mime = mimeFor(f);
      if (f.size > MAX_FILE) {
        const msg = `${f.name}: over the ${prettySize(MAX_FILE)} limit`;
        if (sidRef.current === owner) setNoteState(msg);
        else if (owner) noteCache.set(owner, msg);
        continue;
      }
      const id = crypto.randomUUID();
      setFiles((prev) => [
        ...prev,
        { id, mime, filename: f.name, url: "", size: f.size, status: "reading", progress: 0 },
      ]);
      void readAttachment(f, (p) => {
        if (sidRef.current === owner) {
          setFiles((prev) => prev.map((x) => (x.id === id ? { ...x, progress: p } : x)));
        } else if (owner) {
          const cached = fileCache.get(owner);
          if (cached) fileCache.set(owner, cached.map((x) => (x.id === id ? { ...x, progress: p } : x)));
        }
      }).then((res) => {
        if (!res) {
          const msg = `${f.name}: could not be read`;
          if (sidRef.current === owner) {
            setFiles((prev) => prev.filter((x) => x.id !== id));
            setNoteState(msg);
          } else if (owner) {
            fileCache.set(owner, (fileCache.get(owner) ?? []).filter((x) => x.id !== id));
            noteCache.set(owner, msg);
          }
          return;
        }
        if (sidRef.current === owner) {
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
        } else if (owner) {
          const cached = fileCache.get(owner) ?? [];
          if (cached.some((x) => x.id !== id && x.hash === res.hash)) {
            fileCache.set(owner, cached.filter((x) => x.id !== id));
            noteCache.set(owner, `${f.name}: already attached`);
          } else {
            fileCache.set(
              owner,
              cached.map((x) =>
                x.id === id ? { ...x, status: "ready" as const, progress: 1, url: res.url, hash: res.hash } : x,
              ),
            );
          }
        }
      });
    }
  };

  const removeFile = (id: string) => setFiles((prev) => prev.filter((x) => x.id !== id));

  const clearFiles = () => setFiles([]);

  const readyFiles = () => files.filter((f) => f.status === "ready");

  return { files, note, setNote, dragOver, setDragOver, addFiles, removeFile, clearFiles, readyFiles };
}
