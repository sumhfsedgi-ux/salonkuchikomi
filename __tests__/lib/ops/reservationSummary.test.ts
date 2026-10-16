import { describe, expect, it } from "vitest";
import { RESERVATION_STATUS_LABELS, remainingAfterRelease, summarizeReservation } from "@/lib/ops/reservationSummary";

// 運営管理の「連携と稼働状況」の予約通知: 内部の状態ではなく、実際に通知しているか・止まっている理由・次に必要な対応と担当を出す。
// 利用許可だけを根拠に「通知中」と出さないこと。

const NOW = new Date("2026-10-13T03:00:00Z");
const base = {
  entitlement: { allowed: true, reason: "plan_default" as const },
  holdOpen: false,
  reservation: {
    state: "active" as const,
    legacy: false,
    pauseReason: null,
    masterEnabled: true,
    customerSwitchOn: true,
    lineRecipients: 2,
    activatedAt: "2026-10-01T00:00:00Z",
    lastMailCheckAt: "2026-10-13T02:58:00Z",
  },
  gmail: { authState: "active", scopeMissingSince: null },
  lineInvitesAvailable: true,
  now: NOW,
};

describe("summarizeReservation", () => {
  it("条件がそろい、予約メールの確認も続いていれば「通知中」で、理由は無い", () => {
    expect(summarizeReservation(base)).toEqual({ status: "sending", sending: true, reasons: [] });
    expect(RESERVATION_STATUS_LABELS.sending).toBe("通知中");
  });

  it("利用を許可していても、開始前・連携なし・通知先なしなら「設定が必要」で、通知中とは出さない", () => {
    const s = summarizeReservation({ ...base, reservation: { ...base.reservation, state: null, lineRecipients: 0 }, gmail: null });
    expect(s).toMatchObject({ status: "setup_required", sending: false });
    expect(s.reasons.map((r) => [r.key, r.owner])).toEqual([
      ["not_started", "salon"],
      ["gmail_missing", "salon"],
      ["no_line_recipients", "salon"],
    ]);
    expect(s.reasons.find((r) => r.key === "gmail_missing")!.action).toBe("予約メールを受信するGoogleアカウントを連携してください。");
    expect(s.reasons.find((r) => r.key === "no_line_recipients")!.action).toBe("LINEの通知先を登録してください。");
  });

  it("サロンが通知先を追加できない環境では、LINEの通知先の登録は運営側", () => {
    const s = summarizeReservation({ ...base, lineInvitesAvailable: false, reservation: { ...base.reservation, lineRecipients: 0 } });
    expect(s.reasons.find((r) => r.key === "no_line_recipients")!.owner).toBe("operator");
  });

  it("旧サービスからの切り替え待ちは「切り替え待ち」で、対応は運営側", () => {
    const s = summarizeReservation({ ...base, reservation: { ...base.reservation, state: "awaiting_cutover", legacy: true } });
    expect(s.status).toBe("awaiting_cutover");
    expect(s.reasons).toEqual([
      expect.objectContaining({ key: "awaiting_cutover", action: "旧サービスからの切り替えを完了してください。", owner: "operator" }),
    ]);
  });

  it("旧サービスを使っていない店舗には、切り替えの案内を出さない(開始はサロン側)", () => {
    const s = summarizeReservation({ ...base, reservation: { ...base.reservation, state: "setup_pending", legacy: false } });
    const text = s.reasons.map((r) => `${r.text}${r.action}`).join("");
    expect(text).not.toContain("旧サービス");
    expect(s.reasons[0]).toMatchObject({ key: "not_started", owner: "salon" });
  });

  it("旧サービスから移る店舗の開始前は、切り替えを運営側の対応にする", () => {
    const s = summarizeReservation({ ...base, reservation: { ...base.reservation, state: "setup_pending", legacy: true } });
    expect(s.reasons[0]).toMatchObject({ key: "not_started", owner: "operator" });
  });

  it("止めている理由があれば「停止中」で、すべての理由と対応を出す", () => {
    const s = summarizeReservation({
      ...base,
      entitlement: { allowed: false, reason: "override_deny" },
      holdOpen: true,
      reservation: { ...base.reservation, state: "paused", pauseReason: "確認のため", masterEnabled: false, customerSwitchOn: false, lineRecipients: 0 },
      gmail: { authState: "needs_reauth", scopeMissingSince: null },
    });
    expect(s).toMatchObject({ status: "stopped", sending: false });
    expect(s.reasons.map((r) => r.key)).toEqual([
      "not_entitled",
      "hold",
      "operator_paused",
      "master_off",
      "customer_stopped",
      "gmail_reconnect",
      "no_line_recipients",
    ]);
    expect(s.reasons.find((r) => r.key === "operator_paused")!.text).toBe("運営が一時停止しています(理由: 確認のため)。");
    // 利用許可が無いうちは、解除より先に許可が必要だと案内する
    expect(s.reasons.find((r) => r.key === "hold")!.action).toBe("利用を許可したあと、権限による停止を解除してください。");
    expect(s.reasons.find((r) => r.key === "master_off")!.owner).toBe("salon");
  });

  it("利用許可を外した理由を、プラン対象外と許可しないで分ける", () => {
    const outOfPlan = summarizeReservation({ ...base, entitlement: { allowed: false, reason: "not_in_plan" }, reservation: { ...base.reservation, state: null } });
    expect(outOfPlan.status).toBe("not_in_use");
    // 使っていない店舗には、連携・開始などの設定を求めない
    expect(outOfPlan.reasons.map((r) => r.text)).toEqual(["契約プランの対象外です。"]);
    const denied = summarizeReservation({ ...base, entitlement: { allowed: false, reason: "override_deny" } });
    expect(denied.status).toBe("stopped");
    expect(denied.reasons[0].text).toBe("利用を許可していません。");
  });

  it("利用区分を止めている店舗は、利用許可の保存ではなく、利用区分の変更を案内する", () => {
    const stopped = summarizeReservation({ ...base, entitlement: { allowed: false, reason: "service_pending" }, holdOpen: true });
    expect(stopped.status).toBe("stopped");
    expect(stopped.reasons[0]).toEqual({
      key: "not_entitled",
      text: "利用区分が「利用開始待ち」のため、使えません。",
      action: "再開する場合は、「利用区分」を変更してください(「契約プラン・使える機能」の保存では再開しません)。",
      owner: "operator",
    });
    expect(stopped.reasons[1].action).toBe("「利用区分」を利用中に戻したあと、権限による停止を解除してください。");
    // 一度も始めていない店舗(新しい店舗)には、再開の案内を出さない
    const fresh = summarizeReservation({ ...base, entitlement: { allowed: false, reason: "service_pending" }, reservation: { ...base.reservation, state: null } });
    expect(fresh.status).toBe("not_in_use");
    expect(fresh.reasons).toEqual([{ key: "not_entitled", text: "利用区分が「利用開始待ち」のため、使えません。", action: null, owner: null }]);
  });

  it("稼働中でも予約メールの確認が止まっていれば「確認できません」", () => {
    const s = summarizeReservation({ ...base, reservation: { ...base.reservation, lastMailCheckAt: "2026-10-13T02:00:00Z" } });
    expect(s).toMatchObject({ status: "unverified", sending: false });
    expect(s.reasons[0]).toMatchObject({ key: "mail_check_stale", owner: "operator" });
    expect(RESERVATION_STATUS_LABELS.unverified).toBe("確認できません");
  });

  it("権限による停止を解除しても残る理由だけを返す", () => {
    const s = summarizeReservation({ ...base, holdOpen: true, reservation: { ...base.reservation, masterEnabled: false } });
    expect(remainingAfterRelease(s)).toEqual(["サロンが予約通知の受信をOFFにしています。"]);
  });
});
