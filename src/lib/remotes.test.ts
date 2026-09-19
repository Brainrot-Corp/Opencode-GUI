// runnable self-check: node --experimental-strip-types src/lib/remotes.test.ts
import { isRemoteDir, serverDir, authorityOf, remoteLabel, toOpPath } from "./remotes.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- isRemoteDir ---
eq("ssh:// is remote", isRemoteDir("ssh://u@h/p"), true);
eq("padded ssh is remote", isRemoteDir("  ssh://h "), true);
eq("local path not remote", isRemoteDir("C:\\proj"), false);
eq("null-safe", isRemoteDir(null as unknown as string), false);

// --- serverDir: the ?directory= value the server understands ---
eq("local passthrough", serverDir("C:\\proj"), "C:\\proj");
eq("remote → server-local path", serverDir("ssh://u@h/home/u/proj"), "/home/u/proj");
eq("remote no path → root", serverDir("ssh://u@h"), "/");
eq("remote empty safe", serverDir(""), "");
eq("remote trimmed", serverDir("  ssh://h/x  "), "/x");

// --- authorityOf ---
eq("user@host", authorityOf("ssh://u@h/p"), "u@h");
eq("host only", authorityOf("ssh://h"), "h");
eq("port kept", authorityOf("ssh://u@h:2222/p"), "u@h:2222");
eq("non-remote passthrough", authorityOf("C:\\proj"), "C:\\proj");

// --- remoteLabel ---
eq("label user@host:/path", remoteLabel("ssh://u@h/home/u"), "u@h:/home/u");
eq("label host only", remoteLabel("ssh://h"), "h");
eq("label local passthrough", remoteLabel("C:\\proj"), "C:\\proj");

// --- toOpPath ---
eq("remote path → ssh pseudo-path", toOpPath("/home/u/proj/f.ts", "ssh://u@h/proj"), "ssh://u@h/home/u/proj/f.ts");
eq("relative → absolute", toOpPath("f.ts", "ssh://u@h/proj"), "ssh://u@h/f.ts");
eq("already ssh passthrough", toOpPath("ssh://u@h/x", "ssh://u@h/proj"), "ssh://u@h/x");
eq("local dir passthrough", toOpPath("C:\\f.ts", "C:\\proj"), "C:\\f.ts");
eq("no authority → passthrough", toOpPath("/x", "ssh://"), "/x");
eq("empty absolute", toOpPath("", "ssh://u@h/p"), "");

console.log(`remotes: ${n} checks passed`);
