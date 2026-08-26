// runnable self-check: node --experimental-strip-types src/lib/version.test.ts
import { newer, releaseVersion } from "./version.ts";

let n = 0;
function check(a: string, b: string, want: boolean) {
  n++;
  const got = newer(a, b);
  if (got !== want) throw new Error(`FAIL newer("${a}","${b}") = ${got}, want ${want}`);
}

check("0.1.10", "0.1.9", true);
check("0.1.9", "0.1.10", false);
check("1.2.3", "1.2.3", false);
check("0.2.0", "0.1.99", true);
check("2.0.0", "1.9.9", true);
check("0.1.0", "0.0.9", true);
check("1.0", "0.9.9", true);
check("0.1.0", "0.1", false);

function tag(t: string, want: string) {
  n++;
  const got = releaseVersion(t);
  if (got !== want) throw new Error(`FAIL releaseVersion("${t}") = "${got}", want "${want}"`);
}

tag("Version-1.2.5", "1.2.5");
tag("v1.2.5", "1.2.5");
tag("1.2.5", "1.2.5");
tag("Version 1.2", "1.2");

console.log(`version: ${n} checks passed`);
