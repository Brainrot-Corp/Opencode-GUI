import { createLowlight, common } from "lowlight";

const ll = createLowlight(common);
const block = "function add(a, b) {\n  return a + b;\n}";

// fingerprint check
console.log("js hint:", /\b(?:const |let |var |function |return )|=>|console\.log|require\(/.test(block));

try {
  const tree = ll.highlight("javascript", block);
  const CLASS_SGR: [RegExp, string][] = [
    [/^(comment|quote|meta|doctag)$/, "90"],
    [/^(string|string\..+|regexp|addition)$/, "32"],
    [/^(number)$/, "33"],
    [/^(literal)$/, "36"],
    [/^(keyword|keyword.+|built_in|selector-.+|name)$/, "36"],
    [/^(title|title.+|function_.+)$/, "96"],
    [/^(type|class|attr|attribute|property)$/, "94"],
    [/^(deletion)$/, "91"],
  ];
  function sgrFor(classes: unknown): string | null {
    if (!Array.isArray(classes)) return null;
    for (const cn of classes as string[]) {
      if (typeof cn !== "string" || !cn.startsWith("hljs-")) continue;
      const short = cn.slice(5);
      for (const [re, code] of CLASS_SGR) if (re.test(short)) return code;
    }
    return null;
  }
  const acc: string[] = [];
  function emit(node: any, color: string | null): void {
    if (node.type === "text") {
      acc.push(color ? `\x1b[${color}m${node.value}\x1b[39m` : node.value);
      return;
    }
    if (node.type !== "element") return;
    const next = sgrFor(node.properties?.className) ?? color;
    for (const c of node.children ?? []) emit(c, next);
  }
  for (const c of tree.children ?? []) emit(c, null);
  console.log(JSON.stringify(acc.join("").slice(0, 120)));
} catch (e) {
  console.log("threw:", String(e));
}
