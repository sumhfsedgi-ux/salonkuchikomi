import { describe, expect, it } from "vitest";
import { config } from "@/proxy";

// matcher は path-to-regexp の書き方だが、この形(否定の先読み1つ)はそのまま正規表現として読める。
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe("Proxy の対象", () => {
  it("お客様ページから呼ぶ公開の口コミ生成 API だけを、新しく対象から外す", () => {
    expect(matcher.test("/api/generate-review")).toBe(false);
  });

  it.each(["/dashboard", "/dashboard/reviews", "/login", "/forgot-password", "/api/review-events", "/api/cron/notifications/poll-mail", "/"])(
    "%s は今まで通り対象にする",
    (pathname) => {
      expect(matcher.test(pathname)).toBe(true);
    },
  );

  it.each(["/review/some-salon", "/_next/static/chunk.js", "/favicon.ico", "/logo.png"])("%s は今まで通り対象にしない", (pathname) => {
    expect(matcher.test(pathname)).toBe(false);
  });
});
