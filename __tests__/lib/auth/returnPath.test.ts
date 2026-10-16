import { describe, expect, it } from "vitest";
import { loginPathFor, safeReturnPath, withReturnPath } from "@/lib/auth/returnPath";

const ID = "0b5f3c1e-8a2d-4c6b-9e1f-2a3b4c5d6e7f";

describe("ログインのあとの戻り先", () => {
  it("口コミ詳細(SalonPack 内の UUID)の形だけを許す", () => {
    expect(safeReturnPath(`/dashboard/reviews/google/${ID}`)).toBe(`/dashboard/reviews/google/${ID}`);
    for (const value of [
      "https://evil.example.test/dashboard/reviews/google/" + ID,
      "//evil.example.test/dashboard/reviews/google/" + ID,
      `/dashboard/reviews/google/${ID}?next=https://evil.example.test`,
      `/dashboard/reviews/google/${ID}/`,
      `/dashboard/reviews/google/${ID.toUpperCase()}`,
      "/dashboard/reviews/settings",
      "/dashboard",
      "/ops/salons",
      `/dashboard/reviews/google/${ID}#x`,
      "",
      null,
      undefined,
      ["/dashboard/reviews/google/" + ID],
    ]) {
      expect(safeReturnPath(value)).toBeNull();
    }
  });

  it("店舗の画面へ進むときだけ戻り先に置き換える(本人確認・店舗の登録・利用開始待ちは先に通す)", () => {
    const path = `/dashboard/reviews/google/${ID}`;
    expect(withReturnPath("/dashboard", path)).toBe(path);
    expect(withReturnPath("/auth/verify", path)).toBe("/auth/verify");
    expect(withReturnPath("/onboarding/salon", path)).toBe("/onboarding/salon");
    expect(withReturnPath("/onboarding/status", path)).toBe("/onboarding/status");
    expect(withReturnPath("/ops/salons", path)).toBe("/ops/salons");
    expect(withReturnPath("/dashboard", null)).toBe("/dashboard");
    expect(loginPathFor(path)).toBe(`/login?next=${encodeURIComponent(path)}`);
    expect(loginPathFor(null)).toBe("/login");
  });
});
