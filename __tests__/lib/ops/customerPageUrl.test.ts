import { describe, expect, it } from "vitest";
import { customerPageUrl, requestOrigin } from "@/lib/ops/customerPageUrl";

// お客様用ページのURLは、本番のドメインを固定せず、いま開いている環境から作る。

const h = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

describe("requestOrigin", () => {
  it("プロキシ経由(本番・プレビュー)は x-forwarded-* を使う", () => {
    expect(requestOrigin(h({ host: "internal:3000", "x-forwarded-host": "preview.example.app", "x-forwarded-proto": "https" }))).toBe("https://preview.example.app");
  });

  it("ローカルは http、それ以外で送り先の方式が分からなければ https", () => {
    expect(requestOrigin(h({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(requestOrigin(h({ host: "salonpack.example" }))).toBe("https://salonpack.example");
  });

  it("ホストが分からなければ null(URLを作らない)", () => {
    expect(requestOrigin(h({}))).toBeNull();
  });

  it("お客様用ページのURL", () => {
    expect(customerPageUrl("https://salonpack.example", "aoba-test")).toBe("https://salonpack.example/review/aoba-test");
  });
});
