import { observer } from "mobx-react";
import * as React from "react";
import styled from "styled-components";
import Flex from "../../components/Flex";
import Spinner from "../../components/Spinner";
import Squircle from "../../components/Squircle";
import useIsMounted from "../../hooks/useIsMounted";
import useStores from "../../hooks/useStores";
import { UnfurlResourceType } from "../../types";
import type { EmbedProps as Props } from ".";

/** Structured payload the ZPQWER unfurl provider attaches to the card. */
interface ZpqwerExtras {
  entity: string;
  subtitle?: string;
  fields?: Array<{ label: string; value: string }>;
  links?: Array<{ label: string; url: string }>;
}

/**
 * The shape plugins/zpqwer/server/unfurl.ts emits: a Project-shaped unfurl
 * (its presenter passes plugin payloads through untouched) plus our own
 * structured extras under `zpqwer`.
 */
interface ZpqwerUnfurl {
  type: UnfurlResourceType;
  name?: string;
  color?: string;
  avatarUrl?: string;
  description?: string;
  zpqwer: ZpqwerExtras;
}

/**
 * Narrow an arbitrary unfurl payload to one produced by our own provider.
 * Without this, a payload from any other unfurl source for the same URL would
 * be painted as an authentic-looking staff-portal card.
 *
 * @param data unfurl payload from the store.
 * @returns whether it came from the ZPQWER provider.
 */
function isZpqwerUnfurl(data: unknown): data is ZpqwerUnfurl {
  return (
    !!data &&
    typeof data === "object" &&
    (data as ZpqwerUnfurl).type === UnfurlResourceType.Project &&
    typeof (data as ZpqwerUnfurl).zpqwer === "object" &&
    !!(data as ZpqwerUnfurl).zpqwer
  );
}

/**
 * Inline card for entities from the agency staff portal (my.qwer.agency) —
 * projects, counterparties, specialists, estimates and services.
 *
 * Data arrives through the normal unfurl pipeline (`/api/urls.unfurl` →
 * plugins/zpqwer/server/unfurl.ts), so it is cached per viewer and the portal
 * decides what each reader may see. Readers who never signed in through
 * Bitrix24 — and therefore cannot be matched to a portal profile — get no
 * card at all; the link simply stays a link.
 */
const ZpqwerEmbed = observer(function ZpqwerEmbed(props: Props) {
  const { unfurls } = useStores();
  const isMounted = useIsMounted();
  const [loaded, setLoaded] = React.useState(false);
  const url = props.attrs.href;
  const raw = unfurls.get(url)?.data;
  const data = isZpqwerUnfurl(raw) ? raw : undefined;
  const selectedClass = props.isSelected ? "ProseMirror-selectednode" : "";

  React.useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void unfurls.fetchUnfurl({ url }).finally(() => {
      if (!cancelled && isMounted()) {
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [unfurls, url, isMounted]);

  if (!data) {
    return (
      <PlainLink
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={selectedClass}
      >
        {!loaded ? <Spinner /> : <Squircle color="#80868b" size={14} />}
        <Muted>{url}</Muted>
      </PlainLink>
    );
  }

  const { subtitle = "", fields = [], links = [] } = data.zpqwer;
  const title = data.name ?? "";
  const color = data.color ?? "#1a73e8";
  const description = data.description ?? "";
  // With no fields the description is just the subtitle again.
  const showDescription =
    !fields.length && !!description && description !== subtitle;

  return (
    <Card className={selectedClass}>
      <Flex align="center" gap={8}>
        {data.avatarUrl ? (
          <Avatar src={data.avatarUrl} alt="" />
        ) : (
          <Squircle color={color} size={20} />
        )}
        <Flex column gap={2} style={{ minWidth: 0 }}>
          {/* Stretched link: covers the card so the whole surface is
              clickable, without nesting anchors inside an anchor. */}
          <TitleLink href={url} target="_blank" rel="noopener noreferrer nofollow">
            {title}
          </TitleLink>
          {subtitle ? <Subtitle>{subtitle}</Subtitle> : null}
        </Flex>
      </Flex>

      {fields.length > 0 ? (
        <FieldList>
          {fields.map((f, i) => (
            <React.Fragment key={`${i}-${f.label}`}>
              <FieldLabel>{f.label}</FieldLabel>
              <FieldValue>{f.value}</FieldValue>
            </React.Fragment>
          ))}
        </FieldList>
      ) : showDescription ? (
        <Description>{description}</Description>
      ) : null}

      {links.length > 0 ? (
        <LinkRow>
          {links.map((l) => (
            <ExternalLink
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              {l.label}
            </ExternalLink>
          ))}
        </LinkRow>
      ) : null}
    </Card>
  );
});

// The embed frame sets `line-height: 0` and `white-space: nowrap`, both of
// which are inherited — every text style below restores what it needs.

const Card = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  margin: 4px 0;
  border: 1px solid ${(props) => props.theme.embedBorder};
  border-radius: 6px;
  line-height: 18px;
  white-space: normal;

  &:hover {
    background: ${(props) => props.theme.listItemHoverBackground};
  }
`;

const PlainLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  line-height: 18px;
  text-decoration: none;
  color: inherit;
`;

const Muted = styled.span`
  font-size: 13px;
  color: ${(props) => props.theme.textSecondary};
`;

const TitleLink = styled.a`
  font-weight: 600;
  font-size: 14px;
  line-height: 18px;
  color: inherit;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  /* Covers the whole card, so clicking anywhere opens the entity. */
  &::after {
    content: "";
    position: absolute;
    inset: 0;
  }
`;

const Subtitle = styled.div`
  font-size: 12px;
  line-height: 16px;
  color: ${(props) => props.theme.textSecondary};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const FieldList = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  font-size: 13px;
  line-height: 18px;
`;

const FieldLabel = styled.div`
  color: ${(props) => props.theme.textSecondary};
  white-space: nowrap;
`;

const FieldValue = styled.div`
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Description = styled.div`
  font-size: 13px;
  line-height: 18px;
  color: ${(props) => props.theme.textSecondary};
  white-space: normal;
  overflow-wrap: anywhere;
`;

const LinkRow = styled.div`
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  line-height: 16px;
`;

const ExternalLink = styled.a`
  color: ${(props) => props.theme.link};
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;

const Avatar = styled.img`
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
`;

export default ZpqwerEmbed;
