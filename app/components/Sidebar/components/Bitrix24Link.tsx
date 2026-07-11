import { BackIcon } from "outline-icons";
import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { TeamPreference } from "@shared/types";
import { sanitizeUrl } from "@shared/utils/urls";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import SidebarLink from "./SidebarLink";

export const Bitrix24Link = observer(() => {
  const { t } = useTranslation();
  const team = useCurrentTeam();

  const showButton = team.getPreference(TeamPreference.ShowBitrix24Button);
  const portalUrl = team.getPreference(TeamPreference.Bitrix24PortalUrl);

  // Defence-in-depth: the value is admin-controlled and lands in a plain <a>
  // href, so strip javascript:/data: schemes even though the settings schema
  // should already reject them.
  const safeUrl =
    typeof portalUrl === "string" ? sanitizeUrl(portalUrl) : undefined;

  if (!showButton || !safeUrl) {
    return null;
  }

  return (
    <SidebarLink
      href={safeUrl}
      icon={<BackIcon />}
      label={t("Back to Bitrix24")}
    />
  );
});
