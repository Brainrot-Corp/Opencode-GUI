// semver-ish compare for release tags ("0.1.10" > "0.1.9"). Not full semver:
// numeric segments only, no prerelease handling — the release tags are plain
// dotted versions, which is all the updater ever sees.
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

// release tags on GitHub come in many spellings ("v1.2.5", "Version-1.2.5",
// "1.2.5") — strip everything up to the first digit and keep digits/dots
export function releaseVersion(tag: string): string {
  return (tag.match(/\d[\d.]*/) ?? [""])[0];
}
