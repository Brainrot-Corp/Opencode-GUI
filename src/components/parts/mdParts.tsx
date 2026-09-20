import CodePre from "./CodePre";

// markdown component map — was inline in MessageList.tsx, hoisted here so the
// extracted parts (TaskBlocks, Reasoning) can share it without importing
// back into MessageList. The map itself is unchanged.
export const mdComponents = {
  pre: CodePre,
  // wide tables scroll inside their own wrapper — never force a horizontal
  // scrollbar onto the whole history list
  table: ({ node: _node, children, ...rest }: any) => (
    <div className="md-table">
      <table {...rest}>{children}</table>
    </div>
  ),
};

export function fmtTok(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}
