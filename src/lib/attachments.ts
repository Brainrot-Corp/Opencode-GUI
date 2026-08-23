// base64'd into the prompt body — anything bigger stalls the webview and
// gets rejected by providers anyway
export const MAX_FILE = 50 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  zip: "application/zip",
};

export function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export function prettySize(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// chip icon by mime — shared by composer chips and message rendering
export function iconFor(mime: string): string {
  if (mime.startsWith("image/")) return "fa-image";
  if (mime.startsWith("video/")) return "fa-film";
  if (mime.startsWith("audio/")) return "fa-music";
  if (mime === "application/pdf") return "fa-file-pdf";
  if (mime.startsWith("text/")) return "fa-file-lines";
  return "fa-file";
}

type Ready = { hash: string; url: string };

// app-lifetime cache keyed by name:size:mtime — re-attaching a previously
// picked file skips the read entirely
const byMeta = new Map<string, Ready>();

// reads run one at a time so several heavy picks don't thrash the webview
let chain: Promise<unknown> = Promise.resolve();
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
};

function digest(s: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(s))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

function readAsDataURL(file: File, onProgress: (p: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// null = rejected (over MAX_FILE or unreadable); progress is fractional 0..1.
// hash lets callers drop duplicates already staged in the same draft
export function readAttachment(
  file: File,
  onProgress: (p: number) => void,
): Promise<Ready | null> {
  const meta = `${file.name}:${file.size}:${file.lastModified}`;
  const hit = byMeta.get(meta);
  if (hit) {
    onProgress(1);
    return Promise.resolve(hit);
  }
  if (file.size > MAX_FILE) return Promise.resolve(null);
  return enqueue(async () => {
    const again = byMeta.get(meta);
    if (again) {
      onProgress(1);
      return again;
    }
    try {
      const url = await readAsDataURL(file, onProgress);
      const hash = await digest(url);
      const ready = { hash, url };
      byMeta.set(meta, ready);
      return ready;
    } catch {
      return null;
    }
  });
}
