import httpErrors from "http-errors";

/**
 * Sign-in was aborted because the Bitrix24 profile has no email address.
 * The `id` flows through the passport middleware into the login screen as
 * the `bitrix24-email-missing` notice, which renders a actionable message
 * (see app/scenes/Login/components/Notices.tsx).
 *
 * @param message developer-facing message for the server log.
 * @returns an http-errors instance carrying the notice id.
 */
export function Bitrix24EmailMissingError(
  message = "Email is missing on the Bitrix24 profile"
) {
  return httpErrors(400, message, {
    id: "bitrix24_email_missing",
    isReportable: false,
  });
}

/**
 * The Bitrix24 REST call for the user profile failed — portal unreachable,
 * token rejected, or a malformed response. Rendered on the login screen as
 * the `bitrix24-profile-error` notice.
 *
 * @param message developer-facing message for the server log.
 * @returns an http-errors instance carrying the notice id.
 */
export function Bitrix24ProfileFetchError(
  message = "Could not fetch the user profile from Bitrix24"
) {
  return httpErrors(502, message, {
    id: "bitrix24_profile_error",
    isReportable: false,
  });
}

/**
 * The Bitrix24 account is deactivated on the portal (fired/blocked employee).
 * Rendered on the login screen as the `bitrix24-account-inactive` notice.
 *
 * @param message developer-facing message for the server log.
 * @returns an http-errors instance carrying the notice id.
 */
export function Bitrix24AccountInactiveError(
  message = "The Bitrix24 account is deactivated"
) {
  return httpErrors(403, message, {
    id: "bitrix24_account_inactive",
    isReportable: false,
  });
}
