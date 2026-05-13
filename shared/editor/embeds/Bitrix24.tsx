import { observer } from "mobx-react";
import * as React from "react";
import styled from "styled-components";
import { Backticks } from "../../components/Backticks";
import Flex from "../../components/Flex";
import Spinner from "../../components/Spinner";
import Squircle from "../../components/Squircle";
import Text from "../../components/Text";
import useIsMounted from "../../hooks/useIsMounted";
import useStores from "../../hooks/useStores";
import {
  UnfurlResourceType,
  type UnfurlResponse,
} from "../../types";
import type { EmbedProps as Props } from ".";

/**
 * Inline card for Bitrix24 entities (projects, tasks, deals, contacts, etc.).
 *
 * The card fetches its data via `/api/urls.unfurl` — implemented server-side
 * by `plugins/bitrix24/server/unfurl.ts` — and renders one of four layouts
 * depending on the returned `UnfurlResourceType`:
 *
 *   Project | Issue  → rich card with title, status badge, optional description
 *   Mention         → compact card with name, avatar, subtitle (used for users,
 *                     CRM contacts)
 *   URL             → fallback card with favicon + title (chats, companies)
 *
 * If the user has no Bitrix24 OAuth token (e.g. signed in via email only),
 * the unfurl endpoint returns 204 and we degrade silently to a plain link.
 */
const Bitrix24Embed = observer(function Bitrix24Embed(props: Props) {
  const { unfurls } = useStores();
  const isMounted = useIsMounted();
  const [loaded, setLoaded] = React.useState(false);
  const url = props.attrs.href;
  const unfurl = unfurls.get(url)?.data;

  React.useEffect(() => {
    let cancelled = false;
    void unfurls.fetchUnfurl({ url }).finally(() => {
      if (!cancelled && isMounted()) {
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [unfurls, url, isMounted]);

  // The card is wrapped in an anchor so it acts like a clickable link.
  const Wrap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <Anchor
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={props.isSelected ? "ProseMirror-selectednode" : ""}
    >
      {children}
    </Anchor>
  );

  if (!unfurl) {
    return (
      <Wrap>
        <Inline>
          {!loaded ? <Spinner /> : <Squircle color="#80868b" size={14} />}
          <Text type="secondary" size="small">
            {url}
          </Text>
        </Inline>
      </Wrap>
    );
  }

  switch (unfurl.type) {
    case UnfurlResourceType.Project: {
      const p = unfurl as UnfurlResponse[UnfurlResourceType.Project];
      return (
        <Wrap>
          <Card>
            <Flex align="center" gap={8}>
              {p.avatarUrl ? (
                <Avatar src={p.avatarUrl} alt="" />
              ) : (
                <Squircle color={p.color} size={20} />
              )}
              <Flex column gap={2} style={{ minWidth: 0 }}>
                <Title>
                  <Backticks content={p.name} />
                </Title>
                {p.state ? (
                  <Subtitle>
                    <StateDot $color={p.state.color} /> {p.state.name}
                    {p.lead ? <> · {p.lead.name}</> : null}
                  </Subtitle>
                ) : null}
              </Flex>
            </Flex>
            {p.description ? (
              <Description>{truncate(p.description, 180)}</Description>
            ) : null}
          </Card>
        </Wrap>
      );
    }
    case UnfurlResourceType.Issue: {
      const i = unfurl as UnfurlResponse[UnfurlResourceType.Issue];
      return (
        <Wrap>
          <Card>
            <Flex align="center" gap={8}>
              <StateDot $color={i.state.color} />
              <Flex column gap={2} style={{ minWidth: 0 }}>
                <Title>
                  <Backticks content={i.title} />
                </Title>
                <Subtitle>
                  {i.state.name}
                  {i.author?.name ? <> · {i.author.name}</> : null}
                  {i.labels && i.labels.length > 0 ? (
                    <> · {i.labels.map((l) => l.name).join(", ")}</>
                  ) : null}
                </Subtitle>
              </Flex>
            </Flex>
            {i.description ? (
              <Description>{truncate(i.description, 180)}</Description>
            ) : null}
          </Card>
        </Wrap>
      );
    }
    case UnfurlResourceType.Mention: {
      const m = unfurl as UnfurlResponse[UnfurlResourceType.Mention];
      return (
        <Wrap>
          <Card>
            <Flex align="center" gap={8}>
              {m.avatarUrl ? (
                <Avatar src={m.avatarUrl} alt="" />
              ) : (
                <Squircle color={m.color} size={20} />
              )}
              <Flex column gap={2} style={{ minWidth: 0 }}>
                <Title>
                  <Backticks content={m.name} />
                </Title>
                <Subtitle>
                  {m.email ? <>{m.email}</> : null}
                  {m.lastActive ? (
                    <>
                      {m.email ? " · " : null}
                      {m.lastActive}
                    </>
                  ) : null}
                </Subtitle>
              </Flex>
            </Flex>
          </Card>
        </Wrap>
      );
    }
    default: {
      // URL fallback (chats, companies, anything we mapped to UnfurlResponse[URL]).
      const u = unfurl as UnfurlResponse[UnfurlResourceType.URL];
      return (
        <Wrap>
          <Card>
            <Flex align="center" gap={8}>
              {u.thumbnailUrl ? (
                <Avatar src={u.thumbnailUrl} alt="" />
              ) : u.faviconUrl ? (
                <Favicon src={u.faviconUrl} alt="" />
              ) : (
                <Squircle color={u.color ?? "#1a73e8"} size={20} />
              )}
              <Flex column gap={2} style={{ minWidth: 0 }}>
                <Title>
                  <Backticks content={u.title} />
                </Title>
                {u.description ? (
                  <Subtitle>{truncate(u.description, 120)}</Subtitle>
                ) : null}
              </Flex>
            </Flex>
          </Card>
        </Wrap>
      );
    }
  }
});

/**
 * Trim `s` to `n` characters with an ellipsis. Used for description previews
 * so a long Bitrix24 description does not blow up the card height.
 *
 * @param s source string.
 * @param n max characters before truncation.
 * @returns possibly-truncated string.
 */
function truncate(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }
  return s.slice(0, n - 1).trimEnd() + "…";
}

// ────────────────────────────────────────────────────────────────────────────
// Styled primitives. Kept minimal — these match the visual weight of Outline's
// existing mention cards (Linear, Figma) so the card blends with the document.
// ────────────────────────────────────────────────────────────────────────────

const Anchor = styled.a`
  display: block;
  text-decoration: none;
  color: inherit;
  margin: 4px 0;
  border-radius: 6px;
  overflow: hidden;

  &:hover {
    background: rgba(127, 127, 127, 0.08);
  }
`;

const Card = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 6px;
`;

const Inline = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
`;

const Title = styled.div`
  font-weight: 600;
  font-size: 14px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Subtitle = styled.div`
  font-size: 12px;
  line-height: 16px;
  color: rgba(127, 127, 127, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 4px;
`;

const Description = styled.div`
  font-size: 13px;
  line-height: 18px;
  color: rgba(127, 127, 127, 0.95);
  white-space: pre-wrap;
`;

const Avatar = styled.img`
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: cover;
`;

const Favicon = styled.img`
  width: 16px;
  height: 16px;
  border-radius: 2px;
`;

const StateDot = styled.span<{ $color: string }>`
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${(p) => p.$color};
  flex-shrink: 0;
`;

export default Bitrix24Embed;
