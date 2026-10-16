import { beforeEach, describe, expect, it, vi } from "vitest";

// 口コミの設定タブの「LINE通知」の Server Action。
//   ・Google口コミを使えない店舗は、どの操作も DB・LINE に届かない
//   ・開始・テスト通知・招待は REVIEW_ALERTS_ENABLED のときだけ。停止・OFF・解除はいつでもできる
//   ・テスト通知は口コミ通知が ON の通知先にだけ、本番以外は実際には送らない
// DB・LINE には接続しない(入口の判定と DB 関数・送信を差し替える)。

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
let access: { ok: true; salon: { id: string; name: string }; userId: string } | { ok: false; error: string } = {
  ok: true,
  salon: { id: "salon-1", name: "テスト店" },
  userId: "user-1",
};
vi.mock("@/lib/googleReviews/access", () => ({ resolveGoogleReviewsAccess: async () => access }));
const ops = {
  startReviewAlerts: vi.fn(async (): Promise<string> => "started"),
  stopReviewAlerts: vi.fn(async () => ({ outcome: "stopped", inFlight: 0 })),
  setReviewRecipient: vi.fn(async (): Promise<string> => "updated"),
  takeReviewAlertTestSlot: vi.fn(async () => true),
  reviewAlertTestDestinations: vi.fn(async () => [{ id: "c1", destinationId: `U${"a".repeat(32)}` }]),
};
vi.mock("@/lib/reviews/alerts/ownerOps", () => ops);
const recipientsDb = {
  createInvite: vi.fn(),
  reissueInvite: vi.fn(),
  revokeInvite: vi.fn(),
  removeRecipient: vi.fn(async () => "removed"),
};
vi.mock("@/lib/notifications/recipients/db", () => recipientsDb);
const pushText = vi.fn(async () => ({ outcome: "sent" }));
vi.mock("@/lib/notifications/line/LineClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/line/LineClient")>();
  return { ...actual, pushText };
});

const actions = await import("@/app/dashboard/reviews/settings/alertActions");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  access = { ok: true, salon: { id: "salon-1", name: "テスト店" }, userId: "user-1" };
  vi.stubEnv("REVIEW_ALERTS_ENABLED", "1");
});

describe("口コミの LINE 通知の操作", () => {
  it("Google口コミを使えない店舗は、どの操作も DB に届かない", async () => {
    access = { ok: false, error: "この機能は利用できません。" };
    expect(await actions.startReviewAlertsAction(0)).toEqual({ ok: false, error: "この機能は利用できません。" });
    expect((await actions.stopReviewAlertsAction()).ok).toBe(false);
    expect((await actions.setReviewRecipientAction("c1", true)).ok).toBe(false);
    expect((await actions.sendReviewAlertTestAction()).ok).toBe(false);
    expect((await actions.removeReviewRecipientAction("c1")).ok).toBe(false);
    expect(ops.startReviewAlerts).not.toHaveBeenCalled();
    expect(ops.stopReviewAlerts).not.toHaveBeenCalled();
    expect(ops.setReviewRecipient).not.toHaveBeenCalled();
    expect(recipientsDb.removeRecipient).not.toHaveBeenCalled();
  });

  it("提供していない(REVIEW_ALERTS_ENABLED が空)ときは開始・ON・テスト・招待ができない。停止と OFF はできる", async () => {
    vi.stubEnv("REVIEW_ALERTS_ENABLED", "");
    expect((await actions.startReviewAlertsAction(0)).ok).toBe(false);
    expect((await actions.setReviewRecipientAction("c1", true)).ok).toBe(false);
    expect((await actions.sendReviewAlertTestAction()).ok).toBe(false);
    expect((await actions.createReviewInviteAction("山田")).ok).toBe(false);
    expect(ops.startReviewAlerts).not.toHaveBeenCalled();
    expect((await actions.stopReviewAlertsAction()).ok).toBe(true);
    expect((await actions.setReviewRecipientAction("c1", false)).ok).toBe(true);
    expect(ops.setReviewRecipient).toHaveBeenCalledWith("salon-1", "c1", false, "user-1");
  });

  it("開始はセッションの店舗・ユーザーと画面で読んだ版で呼び、結果を文言にする", async () => {
    expect(await actions.startReviewAlertsAction(3)).toEqual({ ok: true });
    expect(ops.startReviewAlerts).toHaveBeenCalledWith("salon-1", "user-1", 3);
    ops.startReviewAlerts.mockResolvedValueOnce("no_recipients");
    const r = await actions.startReviewAlertsAction(3);
    expect(r.ok === false && r.error).toContain("通知先");
    expect((await actions.startReviewAlertsAction(-1)).ok).toBe(false);
  });

  it("停止の結果に、取り消せない送信の件数を出す", async () => {
    ops.stopReviewAlerts.mockResolvedValueOnce({ outcome: "stopped", inFlight: 2 });
    const r = await actions.stopReviewAlertsAction();
    expect(r.ok && r.message).toContain("2件は取り消せない");
  });

  it("テスト通知: 本番以外は送らない(シミュレーション)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const r = await actions.sendReviewAlertTestAction();
    expect(r).toEqual({ ok: true, message: "送信をシミュレーションしました（実際には送信していません）" });
    expect(pushText).not.toHaveBeenCalled();
    expect(ops.takeReviewAlertTestSlot).not.toHaveBeenCalled();
  });

  it("テスト通知: 本番では ON の通知先にだけ、店舗名と「テスト」の文を送る(ボタン・口コミの内容なし)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SALONPACK_VERIFY_MODE", "");
    vi.stubEnv("GOOGLE_OAUTH_SIMULATED", "");
    vi.stubEnv("LINE_LOGIN_SIMULATED", "");
    vi.stubEnv("LINE_REAL_SEND_VERIFY", "");
    const r = await actions.sendReviewAlertTestAction();
    expect(r.ok).toBe(true);
    expect(pushText).toHaveBeenCalledTimes(1);
    expect(pushText).toHaveBeenCalledWith(`U${"a".repeat(32)}`, "【SalonPack】テスト店\n口コミのLINE通知のテストです。", expect.any(String));
    ops.takeReviewAlertTestSlot.mockResolvedValueOnce(false);
    await actions.sendReviewAlertTestAction();
    expect(pushText).toHaveBeenCalledTimes(1);
    ops.reviewAlertTestDestinations.mockResolvedValueOnce([]);
    expect((await actions.sendReviewAlertTestAction()).ok).toBe(false);
  });

  it("通知先の解除は予約通知と同じ DB 関数(店舗はセッションから)", async () => {
    expect(await actions.removeReviewRecipientAction("c1")).toEqual({ ok: true });
    expect(recipientsDb.removeRecipient).toHaveBeenCalledWith("salon-1", "c1", "owner:user-1");
  });
});
