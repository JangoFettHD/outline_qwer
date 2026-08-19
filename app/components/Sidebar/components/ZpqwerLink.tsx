import { UserIcon } from "outline-icons";
import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { TeamPreference } from "@shared/types";
import { sanitizeUrl } from "@shared/utils/urls";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import SidebarLink from "./SidebarLink";

/**
 * Sidebar link to the agency staff portal (zpqwer / my.qwer.agency), where
 * employees see payroll, project managers run projects, and sales run deals
 * and calculators. Hidden unless an admin enables it and sets the URL in
 * Settings → Details → Integrations.
 */
export const ZpqwerLink = observer(() => {
  const { t } = useTranslation();
  const team = useCurrentTeam();

  const showButton = team.getPreference(TeamPreference.ShowZpqwerButton);
  const portalUrl = team.getPreference(TeamPreference.ZpqwerPortalUrl);

  // Admin-controlled value landing in a plain <a> href — strip
  // javascript:/data: schemes even though the settings schema rejects them.
  const safeUrl =
    typeof portalUrl === "string" ? sanitizeUrl(portalUrl) : undefined;

  if (!showButton || !safeUrl) {
    return null;
  }

  return (
    <SidebarLink
      href={safeUrl}
      icon={<UserIcon />}
      label={t("Personal cabinet")}
    />
  );
});
