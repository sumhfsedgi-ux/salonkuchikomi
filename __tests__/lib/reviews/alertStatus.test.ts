import { describe, expect, it } from "vitest";
import { alertBadge, autoCheckSummary, blockingReason, deliveryStatusText, startChecklist, stopReasonText, type ReviewAlertState } from "@/lib/reviews/alerts/status";
import { inviteTopicItems, inviteTopicLabel, registeredTopicItem } from "@/lib/notifications/line/login/topics";

const ready: ReviewAlertState = {
  alertsAvailable: true,
  enabled: true,
  stopReason: null,
  notifyFrom: "2026-10-16T00:00:00Z",
  consentOk: true,
  googleUsable: true,
  hasLocation: true,
  activeRecipients: 1,
};

describe("LINE通知の状態の表示", () => {
  it("「通知中」は実際に送れる状態のときだけ。止まっている理由があれば「止まっています」", () => {
    expect(alertBadge(ready)).toEqual({ label: "通知中", tone: "success" });
    expect(alertBadge({ ...ready, activeRecipients: 0 }).label).toBe("止まっています");
    expect(alertBadge({ ...ready, googleUsable: false }).label).toBe("止まっています");
    expect(alertBadge({ ...ready, consentOk: false }).label).toBe("止まっています");
    expect(alertBadge({ ...ready, alertsAvailable: false }).label).toBe("準備中");
  });

  it("止めたときは理由で出し分ける(お客様の停止・開始前・利用許可などで止めた)", () => {
    expect(alertBadge({ ...ready, enabled: false, stopReason: "owner" }).label).toBe("停止中");
    expect(alertBadge({ ...ready, enabled: false, notifyFrom: null }).label).toBe("開始前");
    expect(alertBadge({ ...ready, enabled: false, stopReason: "entitlement" }).label).toBe("止まっています");
    expect(stopReasonText("owner")).toBeNull();
    expect(stopReasonText("target_changed")).toContain("再開");
  });

  it("開始の条件と、止まっている理由(優先順)", () => {
    expect(startChecklist(ready).every((c) => c.ok)).toBe(true);
    expect(startChecklist({ ...ready, activeRecipients: 0 }).find((c) => c.key === "recipients")?.ok).toBe(false);
    expect(blockingReason(ready)).toBeNull();
    expect(blockingReason({ ...ready, consentOk: false, googleUsable: false })).toContain("同意");
    expect(blockingReason({ ...ready, googleUsable: false })).toContain("Google");
  });
});

describe("自動確認の表示", () => {
  const now = Date.parse("2026-10-16T01:00:00Z");
  const base = { available: true, connected: true, authHold: false, lastSuccessAt: "2026-10-16T00:50:00Z", consecutiveFailures: 0, pushState: null };

  it("提供していない・連携が終わっていない・再連携が必要", () => {
    expect(autoCheckSummary({ ...base, available: false }, now).label).toBe("準備中");
    expect(autoCheckSummary({ ...base, connected: false }, now).label).toBe("停止中");
    expect(autoCheckSummary({ ...base, authHold: true }, now).label).toBe("止まっています");
  });

  it("30分以上成功が無く失敗が続いていれば「確認できていません」。Google の通知の状態で説明を変える", () => {
    expect(autoCheckSummary({ ...base, lastSuccessAt: "2026-10-16T00:00:00Z", consecutiveFailures: 2 }, now).label).toBe("確認できていません");
    expect(autoCheckSummary({ ...base, consecutiveFailures: 1 }, now).label).toBe("自動で確認しています");
    expect(autoCheckSummary({ ...base, pushState: "ours" }, now).detail).toContain("60分");
    expect(autoCheckSummary({ ...base, pushState: "foreign" }, now).detail).toContain("ほかのサービス");
  });
});

describe("配信の結果の表示", () => {
  it("送信を始めたものは取り消せない・再試行を止めたものは「送信済みかもしれません」", () => {
    expect(deliveryStatusText("claimed", null, false, true)).toContain("取り消せません");
    expect(deliveryStatusText("claimed", null, false, false)).toBe("送信待ち");
    expect(deliveryStatusText("unknown", null, true, true)).toContain("送信済みかもしれません");
    expect(deliveryStatusText("skipped", "recipient_off", false, false)).toBe("送りませんでした(口コミ通知をOFFにしたため)");
    expect(deliveryStatusText("sent", null, false, true)).toBe("送信済み");
  });
});

describe("招待ページの文言", () => {
  it("予約通知だけの店舗では、これまでと同じ文言", () => {
    const t = { reservations: true, reviews: false };
    expect(inviteTopicLabel(t)).toBe("予約通知");
    expect(registeredTopicItem(t)).toBe("お店の予約通知が稼働している間、予約の情報がこのLINEに届きます。");
    expect(inviteTopicItems(t)).toEqual(["このお店の予約の情報(予約の日時・メニュー・お客様のお名前など)が、あなたのLINEに届きます。"]);
  });

  it("口コミを使える店舗では、口コミのお知らせ(内容は届かない)とリンクの先を案内する", () => {
    expect(inviteTopicLabel({ reservations: false, reviews: true })).toBe("口コミのLINE通知");
    expect(inviteTopicLabel({ reservations: true, reviews: true })).toBe("予約・口コミのLINE通知");
    const items = inviteTopicItems({ reservations: false, reviews: true });
    expect(items.some((i) => i.includes("予約の情報"))).toBe(false);
    expect(items.join("")).toContain("口コミの内容・評価・投稿者名は届きません");
    expect(items.join("")).toContain("ログインできる方だけ");
  });
});
