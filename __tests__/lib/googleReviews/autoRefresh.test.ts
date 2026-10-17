import { describe, expect, it } from "vitest";
import { shouldReloadAfterAutoRefresh, shouldShowRefreshError } from "@/lib/googleReviews/autoRefresh";

describe("画面を開いたときの自動の取り込み", () => {
  it("一時的な失敗(取得中・混雑・通信)は、自動では出さず、手動の［更新］では出す", () => {
    const temporary = { ok: false as const, error: "取得中です。", temporary: true as const };
    expect(shouldShowRefreshError(temporary, true)).toBe(false);
    expect(shouldShowRefreshError(temporary, false)).toBe(true);
  });

  it("再連携・同意など利用者の対応が要る失敗は、自動でも出す", () => {
    const needsAction = { ok: false as const, error: "Googleとの連携の確認が必要です。" };
    expect(shouldShowRefreshError(needsAction, true)).toBe(true);
    expect(shouldShowRefreshError(needsAction, false)).toBe(true);
  });

  it("成功は失敗として出さない", () => {
    expect(shouldShowRefreshError({ ok: true, value: { lastCheckedAt: "2026-10-17T00:00:00Z", syncIncomplete: false } }, true)).toBe(false);
  });

  it("5分以内で取得を省いた(最終更新が同じ時刻)なら、一覧を読み直さない", () => {
    expect(
      shouldReloadAfterAutoRefresh({ shownLastCheckedAt: "2026-10-17T00:00:00.123+00:00", lastCheckedAt: "2026-10-17T00:00:00.123Z", listChanged: false }),
    ).toBe(false);
  });

  it("新しく取り込んだら、一覧を読み直す(まだ一度も取り込んでいないときも)", () => {
    expect(shouldReloadAfterAutoRefresh({ shownLastCheckedAt: "2026-10-17T00:00:00Z", lastCheckedAt: "2026-10-17T00:06:00Z", listChanged: false })).toBe(true);
    expect(shouldReloadAfterAutoRefresh({ shownLastCheckedAt: null, lastCheckedAt: "2026-10-17T00:06:00Z", listChanged: false })).toBe(true);
  });

  it("取り込みの間に絞り込み・並び順の変更や続きの読み込みがあったら、表示中の一覧を入れ替えない", () => {
    expect(shouldReloadAfterAutoRefresh({ shownLastCheckedAt: "2026-10-17T00:00:00Z", lastCheckedAt: "2026-10-17T00:06:00Z", listChanged: true })).toBe(false);
  });
});
