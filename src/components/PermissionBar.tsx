import type { PermAsk } from "../types";
import { useTranslation } from "../lib/i18n";
import "../styles/permission.css";

export default function PermissionBar({
  permission,
  onRespond,
}: {
  permission: PermAsk;
  onRespond: (response: "once" | "always" | "reject") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="permission-bar">
      <div className="title">{t("permission.title", { type: permission.type })}</div>
      <div className="what">{permission.title}</div>
      <div className="actions">
        <button className="allow" onClick={() => onRespond("once")}>
          <i className="fa-solid fa-check" />
          {t("permission.allowOnce")}
        </button>
        <button className="allow" onClick={() => onRespond("always")}>
          <i className="fa-solid fa-check-double" />
          {t("permission.alwaysAllow")}
        </button>
        <button className="deny" onClick={() => onRespond("reject")}>
          <i className="fa-solid fa-ban" />
          {t("permission.deny")}
        </button>
      </div>
    </div>
  );
}
