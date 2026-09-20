// live presence snapshot for plugins (discord rich presence reads
// window.__presence for {status} placeholders)
export function mirrorPresence(snap: {
  workspace: string;
  model: string;
  busy: boolean;
  sessionId: string;
  sessionTitle: string;
  editingFile: string;
  diffOpen: boolean;
  diffFiles: string[];
  hasPermission: boolean;
  hasQuestion: boolean;
  compacting: boolean;
  isTyping: boolean;
}) {
  const ws = snap.workspace;
  (window as any).__presence = {
    workspace: ws,
    workspaceName: ws ? ws.split(/[/\\]/).filter(Boolean).pop() || ws : "",
    model: snap.model,
    busy: snap.busy,
    sessionId: snap.sessionId,
    sessionTitle: snap.sessionTitle,
    editingFile: snap.editingFile,
    diffOpen: snap.diffOpen,
    diffFiles: snap.diffFiles,
    hasPermission: snap.hasPermission,
    hasQuestion: snap.hasQuestion,
    compacting: snap.compacting,
    isTyping: snap.isTyping,
  };
}
