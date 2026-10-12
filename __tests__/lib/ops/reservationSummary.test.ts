import { describe, expect, it } from "vitest";
import { remainingAfterRelease, summarizeReservation } from "@/lib/ops/reservationSummary";

// 運営管理の「連携と稼働状況」の予約通知: 内部の状態ではなく、通知しているかと止まっている理由を出す。

const base = {
  entitled: true,
  holdOpen: false,
  reservation: { state: "active" as const, pauseReason: null, masterEnabled: true, customerSwitchOn: true, lineRecipients: 2 },
  gmail: { authState: "active", scopeMissingSince: null },
};

describe("summarizeReservation", () => {
  it("条件がそろっていれば「通知しています」で、理由は無い", () => {
    expect(summarizeReservation(base)).toEqual({ sending: true, reasons: [] });
  });

  it("旧サービスからの切り替え前は、通知していないこととその理由を出す", () => {
    const s = summarizeReservation({ ...base, reservation: { ...base.reservation, state: "awaiting_cutover" } });
    expect(s.sending).toBe(false);
    expect(s.reasons.map((r) => r.key)).toEqual(["awaiting_cutover"]);
    expect(s.reasons[0].text).toContain("旧サービスからの切り替え前です");
  });

  it("止まっている理由をすべて出す(お客様の操作・運営の停止・連携・通知先・権限)", () => {
    const s = summarizeReservation({
      entitled: false,
      holdOpen: true,
      reservation: { state: "paused", pauseReason: "確認のため", masterEnabled: false, customerSwitchOn: false, lineRecipients: 0 },
      gmail: { authState: "needs_reauth", scopeMissingSince: null },
    });
    expect(s.sending).toBe(false);
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
  });

  it("開始前・Gmail 未連携", () => {
    const s = summarizeReservation({ ...base, reservation: { ...base.reservation, state: null }, gmail: null });
    expect(s.reasons.map((r) => r.key)).toEqual(["not_started", "gmail_missing"]);
  });

  it("権限による停止を解除しても残る理由だけを返す", () => {
    const s = summarizeReservation({ ...base, holdOpen: true, reservation: { ...base.reservation, masterEnabled: false } });
    expect(remainingAfterRelease(s)).toEqual(["お客様が予約通知の受信をOFFにしています。"]);
  });
});
