import { NotificationEventType, TeamPreference } from "@shared/types";
import { Document, Notification } from "@server/models";
import type { User } from "@server/models";
import BaseProcessor from "@server/queues/processors/BaseProcessor";
import env from "@server/env";
import Logger from "@server/logging/Logger";
import type { Event, NotificationEvent } from "@server/types";
import pluginEnv from "../env";
import { callWebhook, getBitrix24UserId } from "../rest";

/** Notification events we bridge to Bitrix24 messenger. */
const MENTION_EVENTS = new Set<NotificationEventType>([
  NotificationEventType.MentionedInDocument,
  NotificationEventType.MentionedInComment,
]);

/**
 * Delivers Outline @mention notifications into the recipient's Bitrix24
 * messenger, so a team that lives in Bitrix24 hears about wiki mentions
 * without watching their email.
 *
 * Requires BITRIX24_WEBHOOK_URL (an incoming webhook used as a service
 * credential) and the recipient to have linked their Bitrix24 account (so we
 * know their Bitrix24 user id). Both sides degrade quietly when absent.
 * Gated per-team by the Bitrix24MentionNotifications preference (on unless a
 * workspace admin turns it off).
 */
export default class Bitrix24NotificationsProcessor extends BaseProcessor {
  static applicableEvents: Event["name"][] = ["notifications.create"];

  async perform(event: Event) {
    if (event.name !== "notifications.create") {
      return;
    }
    if (!pluginEnv.BITRIX24_WEBHOOK_URL) {
      return;
    }
    await this.notify(event);
  }

  private async notify(event: NotificationEvent) {
    const notification = await Notification.findByPk(event.modelId, {
      include: [
        { association: "user", required: true },
        { association: "actor", required: true },
      ],
    });
    if (!notification || !MENTION_EVENTS.has(notification.event)) {
      return;
    }

    const recipient = notification.user as User;
    const actor = notification.actor as User;

    // Respect the per-team toggle (defaults to enabled).
    const team = await recipient.$get("team");
    if (
      team &&
      team.getPreference(TeamPreference.Bitrix24MentionNotifications) === false
    ) {
      return;
    }

    const bitrixUserId = await getBitrix24UserId(recipient);
    if (!bitrixUserId) {
      return; // recipient never linked Bitrix24 — nothing to notify
    }

    const document = notification.documentId
      ? await Document.findByPk(notification.documentId, {
          userId: recipient.id,
        })
      : null;
    const title = document?.titleWithDefault ?? "a document";
    const link = document ? `${env.URL}${document.path}` : env.URL;
    const verb =
      notification.event === NotificationEventType.MentionedInComment
        ? "mentioned you in a comment on"
        : "mentioned you in";

    // im.notify.system.add posts a notification from the app to a user. BB-code
    // [URL=…] renders as a clickable link inside Bitrix24 messenger.
    const message = `${actor.name} ${verb} [URL=${link}]${title}[/URL]`;

    const result = await callWebhook("im.notify.system.add", {
      USER_ID: bitrixUserId,
      MESSAGE: message,
      TAG: `outline-doc-${notification.documentId ?? "x"}`,
    });
    if (result === null) {
      Logger.info(
        "processor",
        "Bitrix24 mention notification not delivered (webhook unavailable or failed)",
        { userId: recipient.id }
      );
    }
  }
}
