import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  default: { ZPQWER_BASE_URL: "https://my.qwer.agency", ZPQWER_API_KEY: "k" },
}));

// eslint-disable-next-line import/first
import { clamp, escapeMarkdown } from "./unfurl";

describe("clamp", () => {
  it("tolerates non-string values from the portal", () => {
    // A numeric field value used to throw on .replace and 500 the endpoint.
    expect(clamp(4)).toBe("4");
    expect(clamp(null)).toBe("");
    expect(clamp(undefined)).toBe("");
    expect(clamp({})).toBe("");
  });

  it("collapses whitespace and truncates", () => {
    expect(clamp("  a   b  ")).toBe("a b");
    expect(clamp("abcdef", 4)).toBe("abc…");
  });
});

describe("escapeMarkdown", () => {
  it("neutralises image and link injection", () => {
    expect(escapeMarkdown("![](https://evil/p.png)")).not.toContain("](");
    expect(escapeMarkdown("[Счёт](https://evil)")).toBe(
      "\\[Счёт\\]\\(https://evil\\)"
    );
    expect(escapeMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<");
  });

  it("leaves ordinary card text readable", () => {
    expect(escapeMarkdown("Клиент: ИП Ситникова Д.В. · Статус: в работе")).toBe(
      "Клиент: ИП Ситникова Д.В. · Статус: в работе"
    );
  });
});
