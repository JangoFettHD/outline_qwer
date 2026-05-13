import * as React from "react";
import type { TFunction } from "i18next";
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
 * as plain text, which the unfurl pipeline (see plugins/bitrix24/server/unfurl.ts)
 * subsequently resolves to a rich card on save / re-render.
 *
 * `name` stays `"noop"` so SuggestionsMenu's default `insertNode` branch is
 * taken (no editor command is dispatched); we handle insertion ourselves in
 * `onSelect` to gain direct access to the editor view.
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
  { type: "chat", section: ({ t }) => t("Chats") },
  { type: "user", section: ({ t }) => t("Users") },
  { type: "contact", section: ({ t }) => t("Contacts") },
  { type: "company", section: ({ t }) => t("Companies") },
];

/**
 * Slash-style picker for Bitrix24 entities. Triggered by `:b ` in the editor.
 * On every query change makes parallel calls to `/api/bitrix24.search` for
 * every entity type and concatenates the results into one menu, grouped by
 * section. Selecting a row inserts the entity's canonical Bitrix24 URL at the
 * caret; on next render the unfurl pipeline replaces it with a rich card.
 *
 * @param props standard SuggestionsMenu props (trigger, search query, etc.).
 */
function Bitrix24Menu({ search, isActive, ...rest }: Props) {
  const { view } = useEditor();
  const [items, setItems] = React.useState<Bitrix24Item[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  const { loading, request } = useRequest(
    React.useCallback(async () => {
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

      const collected: Bitrix24Item[] = [];
      for (const { section, hits } of lookups) {
        for (const h of hits) {
          collected.push({
            name: "noop",
            title: h.title,
            subtitle: h.subtitle,
            section,
            url: h.url,
            attrs: { id: h.id, type: h.type, url: h.url },
          });
        }
      }
      setItems(collected);
      setLoaded(true);
    }, [search])
  );

  React.useEffect(() => {
    if (isActive) {
      void request();
    }
  }, [request, isActive]);

  const handleSelect = React.useCallback(
    (item: Bitrix24Item) => {
      // Insert the URL at the caret. The Suggestions plugin trims the trigger
      // text (":b …") via its own clear-search call before onSelect fires, so
      // we can append the URL cleanly without overwriting query characters.
      const { state, dispatch } = view;
      dispatch(state.tr.insertText(item.url));
    },
    [view]
  );

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

  if (!loaded && loading) {
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
      onSelect={handleSelect}
      renderMenuItem={renderMenuItem}
      items={items}
    />
  );
}

export default Bitrix24Menu;
