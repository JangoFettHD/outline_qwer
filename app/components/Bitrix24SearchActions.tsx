import { useKBar } from "kbar";
import { observer } from "mobx-react";
import * as React from "react";
import { Bitrix24Section } from "~/actions/sections";
import { createExternalLinkAction } from "~/actions";
import useCommandBarActions from "~/hooks/useCommandBarActions";
import { client } from "~/utils/ApiClient";

interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  url: string;
}

/** Minimum query length before we hit the Bitrix24 search endpoint. */
const MIN_QUERY = 2;
/** Debounce so each keystroke doesn't fire a request. */
const DEBOUNCE_MS = 250;

/**
 * Surfaces Bitrix24 entities (projects, tasks, deals, chats, …) in the
 * global command bar (Cmd+K). As the user types, one debounced request to
 * `/bitrix24.search?type=all` fetches matches across every entity type;
 * selecting a result opens the entity in Bitrix24 in a new tab.
 *
 * The request returns empty for users who have not linked Bitrix24, so the
 * section simply doesn't appear for them.
 */
function Bitrix24SearchActions() {
  const { searchQuery } = useKBar((state) => ({
    searchQuery: state.searchQuery,
  }));
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const seq = React.useRef(0);

  React.useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < MIN_QUERY) {
      setHits([]);
      return;
    }
    const current = ++seq.current;
    const handle = setTimeout(async () => {
      try {
        const res = (await client.post("/bitrix24.search", {
          type: "all",
          query,
          limit: 5,
        })) as {
          data: { sections: Array<{ type: string; hits: SearchHit[] }> };
        };
        if (current !== seq.current) {
          return; // a newer query superseded this one
        }
        setHits((res.data.sections ?? []).flatMap((s) => s.hits).slice(0, 20));
      } catch {
        if (current === seq.current) {
          setHits([]);
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  const actions = React.useMemo(
    () =>
      hits.map((h) =>
        createExternalLinkAction({
          id: `bitrix24-${h.type}-${h.id}`,
          name: h.title,
          section: Bitrix24Section,
          url: h.url,
          target: "_blank",
        })
      ),
    [hits]
  );

  useCommandBarActions(actions, [actions]);

  return null;
}

export default observer(Bitrix24SearchActions);
