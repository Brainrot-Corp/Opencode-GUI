import Titlebar from "../components/Titlebar";
import Sidebar from "../components/Sidebar";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PermissionBar from "../components/PermissionBar";
import { useOpencode } from "../hooks/useOpencode";

export default function ChatPage() {
  const oc = useOpencode();

  return (
    <>
      <div className="noise" aria-hidden="true" />
      <div className="app">
        <Titlebar />
        <div className="layout">
          <Sidebar
            sessions={oc.sessions}
            activeId={oc.activeId}
            onNew={oc.newSession}
            onOpen={(id) => oc.openSession(id)}
            onDelete={(id) => oc.removeSession(id)}
          />
          <div className="main">
            {oc.error && <div className="banner">{oc.error}</div>}
            {!oc.activeId ? (
              <p className="empty">Select or create a session to start.</p>
            ) : (
              <>
                <MessageList msgs={oc.msgs} busy={oc.busy} />
                {oc.permission && (
                  <PermissionBar permission={oc.permission} onRespond={oc.respondToPermission} />
                )}
                <Composer
                  busy={oc.busy}
                  providers={oc.providers}
                  modelSel={oc.modelSel}
                  onModelSelect={oc.setModelSel}
                  onSend={oc.send}
                  onAbort={oc.abort}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
