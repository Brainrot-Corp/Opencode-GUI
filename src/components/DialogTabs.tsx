import type { CSSProperties } from "react";

// tab strip shared by the centered dialogs (Info/Voices/Plugins/SSH):
// .dlg-tabs + .dlg-tab buttons, active tab gets .on
export default function DialogTabs<V extends string>({
  tabs,
  value,
  onChange,
  style,
}: {
  tabs: readonly (readonly [V, string])[];
  value: V;
  onChange: (id: V) => void;
  style?: CSSProperties;
}) {
  return (
    <div className="dlg-tabs" style={style}>
      {tabs.map(([id, label]) => (
        <button key={id} type="button" className={`dlg-tab${value === id ? " on" : ""}`} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
