// Deprecated stub — tuya-curtains-control was merged into tuya-lights-control v2.
// This plugin now does nothing except surface a deprecation notice. Remove this
// folder and use default_plugins/tuya-lights-control (id tuya-lights-control,
// now handles lights + curtains + slash for both).
export default function activate(api) {
  try { console.warn("[tuya-curtains-control] deprecated: merged into tuya-lights-control v2 — please delete this plugin folder and update tuya-lights-control"); } catch {}
  return {
    info: {
      voice: [["(deprecated)", "merged into Tuya — use Lights & Curtains plugin"]],
      keys: [["(deprecated)", "remove tuya-curtains-control, use tuya-lights-control"]]
    }
  };
}
