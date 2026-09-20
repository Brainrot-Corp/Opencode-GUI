// runs every src/lib/*.test.ts + src/mobile/*.test.ts via node
// --experimental-strip-types (repo convention: framework-free assert
// self-checks). Exits 1 if any file fails.
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const dirs = ["lib", "mobile"].map((d) => join(here, "..", "src", d));
const files = dirs.flatMap((dir) =>
  readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => join(dir, f)),
).sort();

let failed = 0;
for (const f of files) {
  console.log(`>> ${f.split(/[\\/]/).pop()}`);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", f], {
    stdio: "inherit",
  });
  if (r.status !== 0) failed++;
}
console.log(failed ? `>> ${failed}/${files.length} test files FAILED` : `>> all ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
