import { describe, expect, test } from "bun:test";
import { displayPath, isSensitivePath, redactText } from "../src/privacy.ts";

describe("privacy", () => {
  test("redacts api keys", () => {
    const s = redactText("token=sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(s).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(s.toLowerCase()).toContain("redacted");
  });

  test("sensitive paths", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("secrets/credentials.json")).toBe(true);
    expect(isSensitivePath("src/order.ts")).toBe(false);
  });

  test("displayPath is project relative", () => {
    const cwd = "/Users/box/dev-code/pi-agent-history-recall";
    expect(displayPath(`${cwd}/src/a.ts`, cwd)).toBe("src/a.ts");
  });
});
