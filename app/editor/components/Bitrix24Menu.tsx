import * as React from "react";
import type { TFunction } from "i18next";
import type { EditorView } from "prosemirror-view";
import type { MenuItem } from "@shared/editor/types";
import useRequest from "~/hooks/useRequest";
import { client } from "~/utils/ApiClient";
import { useEditor } from "./EditorContext";
import type { Props as SuggestionsMenuProps } from "./SuggestionsMenu";
import SuggestionsMenu from "./SuggestionsMenu";
import SuggestionsMenuItem from "./SuggestionsMenuItem";

/**
 * Items rendered in the Bitrix24 picker. They are not real ProseMirror nodes —
 * on selection the menu inserts the entity's canonical URL into the document
 * as a clickable link. Outline's editor matches the URL against the Bitrix24
 * EmbedDescriptor on next render and swaps the link for an inline card.
 *
 * `name` is `"noop"` so SuggestionsMenu does NOT try to look up an editor
 * command for us — and crucially still calls `handleClearSearch` (removes
 * the `:b query` text) BEFORE invoking `onClick`. We rely on that order to
 * append a clean URL without leaking the trigger characters.
 */
interface Bitrix24Item extends MenuItem {
  /** Canonical Bitrix24 URL to insert. */
  url: string;
}

interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  avatarUrl?: string;
  url: string;
}

type Props = Omit<
  SuggestionsMenuProps<Bitrix24Item>,
  "renderMenuItem" | "items" | "embeds"
>;

/**
 * Map entity type to a human-readable section heading used as both the
 * picker's section label and the type sent to `/api/bitrix24.search` to scope
 * results. Order here decides display order in the picker. `section` is a
 * `(t) => string` factory so the SuggestionsMenu picks up the current locale
 * via the editor's translation function.
 */
const SECTIONS: Array<{
  type: string;
  section: ({ t }: { t: TFunction }) => string;
}> = [
  { type: "workgroup", section: ({ t }) => t("Projects") },
  { type: "task", section: ({ t }) => t("Tasks") },
  { type: "deal", section: ({ t }) => t("Deals") },
  { type: "lead", section: ({ t }) => t("Leads") },
  { type: "event", section: ({ t }) => t("Events") },
  { type: "chat", section: ({ t }) => t("Chats") },
  { type: "user", section: ({ t }) => t("Users") },
  { type: "contact", section: ({ t }) => t("Contacts") },
  { type: "company", section: ({ t }) => t("Companies") },
];

/** Time to wait after the last keystroke before sending a new search. */
const DEBOUNCE_MS = 200;

/**
 * Insert a URL at the current caret position and mark it as a link. We do
 * this in one transaction so undo treats it as a single step. The link mark
 * makes the URL clickable; on next render the embed system swaps it for an
 * inline card if the URL matches the Bitrix24 EmbedDescriptor.
 *
 * @param view active ProseMirror editor view.
 * @param url URL to insert.
 */
function insertUrlAsLink(view: EditorView, url: string): void {
  const { state, dispatch } = view;
  const { from } = state.selection;
  const tr = state.tr.insertText(url, from);
  const linkMark = state.schema.marks.link;
  if (linkMark) {
    tr.addMark(from, from + url.length, linkMark.create({ href: url }));
  }
  dispatch(tr);
}

/**
 * Slash-style picker for Bitrix24 entities.
 *
 * Entry points:
 *   - `:b <query>` typed inline in the editor.
 *   - `/Bitrix24` in the block menu — the `bitrix24Picker` editor command
 *     inserts `:b ` for the user so this same picker opens.
 *
 * Both entry points feed the live `:b <query>` text into `props.search`, so
 * the user can refine the query at any time without closing the popover —
 * each keystroke triggers a debounced server search via
 * `/api/bitrix24.search` fanned out across all entity types in parallel.
 *
 * Selecting a row inserts the entity's canonical Bitrix24 URL at the caret
 * as a link; the Bitrix24 EmbedDescriptor matches the URL on re-render and
 * replaces it with a rich card.
 *
 * @param props standard SuggestionsMenu props (trigger, search, isActive…).
 */
function Bitrix24Menu({ search, isActive, ...rest }: Props) {
  const { view } = useEditor();
  const [items, setItems] = React.useState<Bitrix24Item[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  // Each fetch carries a sequence number; older completions are discarded
  // so a slow first request can't overwrite results from a newer query.
  const fetchSeq = React.useRef(0);

  const { request } = useRequest(
    React.useCallback(async () => {
      const seq = ++fetchSeq.current;
      const lookups = await Promise.all(
        SECTIONS.map((sec) =>
          client
            .post("/bitrix24.search", {
              type: sec.type,
              query: search ?? "",
              limit: 6,
            })
            .then((res: { data: SearchHit[] }) => ({
              section: sec.section,
              hits: res.data ?? [],
            }))
            // Swallow per-section failures so one slow / broken endpoint
            // doesn't blank out the whole picker.
            .catch(() => ({ section: sec.section, hits: [] }))
        )
      );

      // A newer query was fired while we were waiting — drop these results.
      if (seq !== fetchSeq.current) {
        return;
      }

      const collected: Bitrix24Item[] = [];
      for (const { section, hits } of lookups) {
        for (const h of hits) {
          // Bind `url` into the closure so each row's onClick inserts the
          // correct entity. onClick is invoked by SuggestionsMenu AFTER
          // handleClearSearch has stripped the `:b query` trigger text.
          const url = h.url;
          collected.push({
            name: "noop",
            title: h.title,
            subtitle: h.subtitle,
            section,
            url,
            onClick: () => insertUrlAsLink(view, url),
            attrs: { id: h.id, type: h.type, url },
          });
        }
      }
      setItems(collected);
      setLoaded(true);
    }, [search, view])
  );

  // Debounce searches: each keystroke after `:b` would otherwise fire 9
  // parallel REST calls and Bitrix24's per-method rate limits would
  // immediately throttle us.
  React.useEffect(() => {
    if (!isActive) {
      return undefined;
    }
    const handle = setTimeout(() => void request(), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [request, isActive]);

  const renderMenuItem = React.useCallback(
    (item: Bitrix24Item, _index: number, options) => (
      <SuggestionsMenuItem
        {...options}
        title={item.title}
        subtitle={item.subtitle}
      />
    ),
    []
  );

  if (!loaded) {
    // First render: avoid flashing an empty popover. SuggestionsMenu computes
    // its height from items so showing 0 results would mis-position it.
    return null;
  }

  return (
    <SuggestionsMenu
      {...rest}
      isActive={isActive}
      filterable={false}
      search={search}
      renderMenuItem={renderMenuItem}
      items={items}
    />
  );
}

export default Bitrix24Menu;
