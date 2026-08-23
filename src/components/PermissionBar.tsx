import type { PermAsk } from "../types";
import "../styles/permission.css";

export default function PermissionBar({
  permission,
  onRespond,
}: {
  permission: PermAsk;
  onRespond: (response: "once" | "always" | "reject") => void;
}) {
  return (
    <div className="permission-bar">
      <div className="title">Permission required · {permission.type}</div>
      <div className="what">{permission.title}</div>
      <div className="actions">
        <button className="allow" onClick={() => onRespond("once")}>
          <i className="fa-solid fa-check" />
          Allow once
        </button>
        <button className="allow" onClick={() => onRespond("always")}>
          <i className="fa-solid fa-check-double" />
          Always allow
        </button>
        <button className="deny" onClick={() => onRespond("reject")}>
          <i className="fa-solid fa-ban" />
          Deny
        </button>
      </div>
    </div>
  );
}
