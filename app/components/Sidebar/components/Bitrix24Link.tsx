import { BackIcon } from "outline-icons";
import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { TeamPreference } from "@shared/types";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import SidebarLink from "./SidebarLink";

export const Bitrix24Link = observer(() => {
  const { t } = useTranslation();
  const team = useCurrentTeam();

  const showButton = team.getPreference(TeamPreference.ShowBitrix24Button);
  const portalUrl = team.getPreference(TeamPreference.Bitrix24PortalUrl);

  if (!showButton || !portalUrl) {
    return null;
  }

  return (
    <SidebarLink
      href={portalUrl}
      icon={<BackIcon />}
      label={t("Back to Bitrix24")}
    />
  );
});
