import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import ContextMenu, { type CtxItem } from "../components/ContextMenu";

type CtxState = { x: number; y: number; items: CtxItem[] } | null;

const Ctx = createContext<{ show: (x: number, y: number, items: CtxItem[]) => void; close: () => void } | null>(null);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CtxState>(null);
  const show = useCallback((x: number, y: number, items: CtxItem[]) => setState({ x, y, items }), []);
  const close = useCallback(() => setState(null), []);
  return (
    <Ctx.Provider value={{ show, close }}>
      {children}
      {state && <ContextMenu x={state.x} y={state.y} items={state.items} onClose={close} />}
    </Ctx.Provider>
  );
}

export function useContextMenu() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useContextMenu must be inside ContextMenuProvider");
  return v;
}
