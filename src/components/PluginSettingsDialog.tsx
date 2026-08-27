import Dialog from "./Dialog";
import type { LoadedPlugin } from "../lib/plugins";
import type { AppSettings } from "../hooks/useSettings";

export default function PluginSettingsDialog({
  plugin,
  settings,
  updatePlugin,
  onClose,
}: {
  plugin: LoadedPlugin | null;
  settings: AppSettings;
  updatePlugin: (id: string, patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  if (!plugin) return null;
  const C = plugin.ext?.Settings;
  if (!C) return null;
  return (
    <Dialog title={`${plugin.name} — Settings`} onClose={onClose} top wide>
      <C open={true} settings={settings} updatePlugin={(patch) => updatePlugin(plugin.id, patch)} />
    </Dialog>
  );
}
