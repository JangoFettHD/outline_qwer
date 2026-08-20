import { beforeAll, describe, expect, it, vi } from "vitest";
import type { parseZpqwerUrl as ParseZpqwerUrl } from "./parser";

let parseZpqwerUrl: typeof ParseZpqwerUrl;

beforeAll(async () => {
  // The plugin env object reads process.env when it is constructed, so the
  // portal URL has to be in place before the module graph is imported.
  process.env.ZPQWER_BASE_URL = "https://my.qwer.agency";
  process.env.ZPQWER_API_KEY = "test-key";
  // The plugin's env singleton is already in the module cache from server
  // bootstrap, where the variables were unset — drop it so it rebuilds.
  vi.resetModules();
  ({ parseZpqwerUrl } = await import("./parser"));
});

const uuid = "60050a14-788e-4ce0-a625-c153b9d6e9e6";

describe("parseZpqwerUrl", () => {
  it("parses each supported entity URL", () => {
    expect(
      parseZpqwerUrl(`https://my.qwer.agency/admin/projects/${uuid}`)
    ).toEqual({ type: "project", id: uuid });
    expect(
      parseZpqwerUrl(`https://my.qwer.agency/admin/counterparties/${uuid}/`)
    ).toEqual({ type: "counterparty", id: uuid });
    expect(
      parseZpqwerUrl(`https://my.qwer.agency/admin/specialists/${uuid}`)
    ).toEqual({ type: "specialist", id: uuid });
    expect(
      parseZpqwerUrl(`https://my.qwer.agency/sales/calc/${uuid}?a=1`)
    ).toEqual({ type: "estimate", id: uuid });
    expect(
      parseZpqwerUrl("https://my.qwer.agency/sales/services/context_ads")
    ).toEqual({ type: "service", id: "context_ads" });
  });

  it("rejects other hosts, other paths and malformed ids", () => {
    expect(
      parseZpqwerUrl(`https://evil.example/admin/projects/${uuid}`)
    ).toBeNull();
    expect(parseZpqwerUrl("https://my.qwer.agency/cabinet/rules")).toBeNull();
    expect(
      parseZpqwerUrl("https://my.qwer.agency/admin/projects/not-a-uuid")
    ).toBeNull();
    expect(parseZpqwerUrl("not a url")).toBeNull();
  });
});
