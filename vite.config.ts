import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  build: {
    // dict chunk is ~3.2 MB of english words (an-array-of-english-words) — already
    // code-split via dynamic import() and excluded from the initial load.
    // Initial chunks are kept <500 kB; the limit is raised only to silence the
    // expected warning for this intentionally-lazy dictionary chunk.
    chunkSizeWarningLimit: 3600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("an-array-of-english-words")) return "dict";
          if (id.includes("@xterm")) return "xterm";
          // markdown + syntax highlighting stack — isolated so the initial
          // vendor chunk stays <500kB; generic utils (bail/trough/etc.) stay
          // in vendor to avoid circular deps (markdown -> vendor is fine,
          // vendor -> markdown would be circular)
          if (
            id.includes("react-markdown") ||
            id.includes("remark-gfm") ||
            id.includes("rehype-highlight") ||
            id.includes("lowlight") ||
            id.includes("hast-util-to-html") ||
            id.includes("unified") ||
            id.includes("micromark") ||
            id.includes("mdast-util") ||
            id.includes("hast-util-") ||
            id.includes("remark-") ||
            id.includes("rehype-")
          )
            return "markdown";
          return "vendor";
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
