import { UnfurlResourceType } from "@shared/types";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import type { Unfurl, UnfurlSignature } from "@server/types";
import { parseZpqwerUrl, type ZpqwerEntityType } from "./parser";
import { fetchCard, isHttpUrl, isPortalUrl, type ZpqwerCard } from "./rest";

/** Hard cap on any single string we cache and ship to the client. */
const MAX_LEN = 400;

/** Accent colours per entity type, used for the card's avatar placeholder. */
const COLOR: Record<ZpqwerEntityType, string> = {
  project: "#1a73e8",
  counterparty: "#34a853",
  specialist: "#a142f4",
  estimate: "#f9ab00",
  service: "#00a3a3",
};

/** Human labels used when a card has no subtitle of its own. */
const ENTITY_LABEL: Record<ZpqwerEntityType, string> = {
  project: "Проект",
  counterparty: "Контрагент",
  specialist: "Сотрудник",
  estimate: "Смета",
  service: "Услуга",
};

/**
 * Collapse whitespace and clamp length. Accepts `unknown` because every value
 * here comes from an external service: a numeric field value would otherwise
 * throw on `.replace` and 500 the whole unfurl endpoint.
 *
 * Note this does NOT make a string safe for Markdown — see escapeMarkdown.
 *
 * @param s raw value.
 * @param max maximum length.
 * @returns tidied string, empty when the input is not a usable string.
 */
export function clamp(s: unknown, max = MAX_LEN): string {
  if (typeof s === "number" && Number.isFinite(s)) {
    s = String(s);
  }
  if (typeof s !== "string") {
    return "";
  }
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Neutralise Markdown in a portal-supplied string.
 *
 * The card's `description` is rendered by HoverPreviewProject through a full
 * ProseMirror editor (`<Editor defaultValue={description} />`), i.e. it is
 * parsed as Markdown — so `![](https://evil/x.png)` would become a live
 * tracking beacon and `[Счёт](https://evil)` a plausible phishing link, in
 * text that any employee can type into a project name on the portal.
 *
 * @param s plain text.
 * @returns text that renders literally in a Markdown context.
 */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/[<>]/g, "")
    .replace(/([\\`*_~[\]()#>|!])/g, "\\$1");
}

/**
 * Normalise the portal's `fields` array, which the contract explicitly says
 * is not a fixed key set.
 *
 * @param value raw `fields` value.
 * @returns clean label/value pairs.
 */
function toFields(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((f) => ({
      label: clamp((f as { label?: unknown })?.label, 40),
      value: clamp((f as { value?: unknown })?.value, 160),
    }))
    .filter((f) => f.label && f.value)
    .slice(0, 12);
}

/**
 * Normalise the portal's `links` array, dropping anything that is not a plain
 * http(s) URL so a `javascript:` value can never reach an href.
 *
 * @param value raw `links` value.
 * @returns clean label/url pairs.
 */
function toLinks(value: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((l) => ({
      label: clamp((l as { label?: unknown })?.label, 60),
      url: (l as { url?: unknown })?.url,
    }))
    .filter((l): l is { label: string; url: string } => !!l.label && isHttpUrl(l.url))
    .slice(0, 6);
}

/**
 * Compose the card's labelled fields into one readable line. This is what
 * renders in hover previews and in any generic renderer that does not know
 * about our structured extras.
 *
 * @param fields normalised fields.
 * @returns description string.
 */
function describeFields(
  fields: Array<{ label: string; value: string }>
): string {
  return clamp(fields.map((f) => `${f.label}: ${f.value}`).join(" · "), MAX_LEN);
}

/**
 * `Hook.UnfurlProvider` implementation for the staff portal.
 *
 * Emits a Project-shaped unfurl: its presenter passes plugin payloads through
 * untouched, so we can carry the portal's structured `fields`/`links` to the
 * embed component while the standard Project keys still make the card render
 * sensibly if those extras are ever dropped.
 *
 * Returns the `{ error }` sentinel — not `undefined` — once we know the URL is
 * a portal URL we could not resolve. That caches the miss for 60s and stops
 * the provider chain, so a portal URL is never handed to a third-party
 * unfurler. `undefined` is reserved for URLs that are not ours at all.
 */
export const unfurl: UnfurlSignature = async (
  url: string,
  actor?: User
): Promise<Unfurl | undefined> => {
  if (!actor) {
    return undefined;
  }
  const parsed = parseZpqwerUrl(url);
  if (!parsed) {
    return undefined;
  }

  // Consumed by urls.ts as a cached negative result for this URL.
  const notFound = { error: "not_found" } as unknown as Unfurl;

  try {
    const card: ZpqwerCard | null = await fetchCard(actor, parsed.type, parsed.id);
    const title = clamp(card?.title, 160);
    if (!card || !title) {
      return notFound;
    }

    const fields = toFields(card.fields);
    const links = toLinks(card.links);
    const subtitle = clamp(card.subtitle, 160);
    const description = describeFields(fields) || subtitle;

    const payload = {
      type: UnfurlResourceType.Project,
      // Only ever link to the portal itself.
      url: isPortalUrl(card.url) ? card.url : url,
      id: clamp(card.id, 64) || parsed.id,
      name: title,
      color: COLOR[parsed.type],
      // Rendered as <img src>, so it must be portal-hosted too.
      avatarUrl: isPortalUrl(card.imageUrl) ? card.imageUrl : undefined,
      // Markdown-escaped: the hover preview parses this through the editor.
      description: description ? escapeMarkdown(description) : null,
      lead: null,
      state: {
        name: subtitle || ENTITY_LABEL[parsed.type],
        color: COLOR[parsed.type],
        type: parsed.type,
      },
      labels: [],
      createdAt: new Date().toISOString(),
      targetDate: null,
      // Structured extras consumed by shared/editor/embeds/Zpqwer.tsx. Carried
      // on the Project branch because its presenter is a pass-through; the card
      // degrades to name + description if a future release stops passing them.
      zpqwer: { entity: parsed.type, subtitle, fields, links },
    };

    // The Project shape is a fixed object type, so the structured extras need
    // an explicit widening. They survive `presentUnfurl` untouched.
    return payload as unknown as Unfurl;
  } catch (err) {
    // urls.ts does not wrap provider calls, so anything thrown here would 500
    // the endpoint for every provider, not just this one.
    Logger.warn(`ZPQWER unfurl failed: ${(err as Error).message}`);
    return notFound;
  }
};
