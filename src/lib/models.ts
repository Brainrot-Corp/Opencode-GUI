// "openrouter/deepseek/deepseek-chat" -> ["openrouter", "deepseek/deepseek-chat"]
// model IDs embed slashes — never split("/") destructurally
export function splitModel(sel: string): [string, string] {
  const i = sel.indexOf("/");
  return i < 0 ? [sel, ""] : [sel.slice(0, i), sel.slice(i + 1)];
}
