import { describe, expect, it } from "vitest";
import { buildRollbackPlan, mapStaffEmail, reconcileEmail, summarize, type HmailStaffEmailState } from "../../scripts/legacyReconcile";

const base = (overrides: Partial<HmailStaffEmailState>): HmailStaffEmailState => ({
  staffId: "staff-a",
  providerMessageId: "m1",
  processed: { eventType: "new_reservation", processedAt: "2026-10-08T00:00:00Z" },
  history: [],
  ...overrides,
});

describe("メール×スタッフの照合(結果不明を未送信として扱わない)", () => {
  it.each([
    ["そのスタッフ向けに一度も処理していない → 新側へ引き継ぐ", base({ processed: null }), "handover"],
    ["送信済み", base({ history: [{ status: "sent", errorMessage: null, lineText: "t", eventType: "new_reservation" }] }), "sent"],
    ["通知設定で OFF", base({ history: [{ status: "skipped_disabled", errorMessage: null, lineText: null, eventType: "new_reservation" }] }), "skipped"],
    ["LINE 未連携", base({ history: [{ status: "failed", errorMessage: "LINE未連携", lineText: null, eventType: "new_reservation" }] }), "skipped"],
    ["その他の失敗(タイムアウト等で届いている可能性)", base({ history: [{ status: "failed", errorMessage: "timeout", lineText: "t", eventType: "new_reservation" }] }), "needs_review"],
    ["クレーム済み・種別未記録・履歴なし", base({ processed: { eventType: "pending", processedAt: "x" } }), "needs_review"],
    ["分類済み・履歴なし(送信前後で停止)", base({}), "needs_review"],
    ["予約メールではない", base({ processed: { eventType: "not_hotpepper", processedAt: "x" } }), "not_hotpepper"],
  ])("%s", (_label, state, kind) => {
    expect(mapStaffEmail(state).kind).toBe(kind);
  });

  it("送信済みと失敗が両方あれば送信済みを優先、失敗と OFF なら確認待ちを優先", () => {
    expect(
      mapStaffEmail(base({ history: [{ status: "failed", errorMessage: "x", lineText: null, eventType: "e" }, { status: "sent", errorMessage: null, lineText: "t", eventType: "e" }] })).kind
    ).toBe("sent");
    expect(
      mapStaffEmail(base({ history: [{ status: "skipped_disabled", errorMessage: null, lineText: null, eventType: "e" }, { status: "failed", errorMessage: "x", lineText: null, eventType: "e" }] })).kind
    ).toBe("needs_review");
  });
});

describe("メール単位の判断は、対象スタッフ全員の状態で決める(processed_emails の和集合で判断しない)", () => {
  it("一部のスタッフだけ送信済みなら「一部だけ処理済み」で、残りは引き継ぎ", () => {
    const states = [base({ staffId: "a", history: [{ status: "sent", errorMessage: null, lineText: "t", eventType: "new_reservation" }] })];
    const r = reconcileEmail("m1", states, ["a", "b", "c"]);
    expect(r.fullyHandled).toBe(false);
    expect(r.outcomes.get("b")!.kind).toBe("handover");
    expect(summarize([r])).toMatchObject({ sent: 1, handover: 2, partially_handled_emails: 1 });
  });

  it("全員に決着がついていれば引き継ぎ不要", () => {
    const sent = { status: "sent", errorMessage: null, lineText: "t", eventType: "cancellation" };
    const r = reconcileEmail("m1", [base({ staffId: "a", history: [sent] }), base({ staffId: "b", history: [{ ...sent, status: "skipped_disabled" }] })], ["a", "b"]);
    expect(r.fullyHandled).toBe(true);
    expect(r.eventType).toBe("new_reservation");
  });
});

describe("切り戻しB: メール×スタッフごとに判断する(メール全体を処理済みにしない)", () => {
  it("送信済み・送らないと決めた組だけ旧側の処理済みにし、未送信は旧側へ、結果不明はそのスタッフを保留", () => {
    const plan = buildRollbackPlan([
      { providerMessageId: "m1", lineConnectionId: "a", status: "sent", origin: "salonpack", firstAttemptAt: "x", eventType: "new_reservation" },
      { providerMessageId: "m1", lineConnectionId: "b", status: "pending", origin: "salonpack", firstAttemptAt: null, eventType: "new_reservation" },
      { providerMessageId: "m1", lineConnectionId: "c", status: "unknown", origin: "salonpack", firstAttemptAt: "x", eventType: "new_reservation" },
      { providerMessageId: "m2", lineConnectionId: "b", status: "skipped", origin: "salonpack", firstAttemptAt: null, eventType: "cancellation" },
      { providerMessageId: "m0", lineConnectionId: "a", status: "sent", origin: "hmail", firstAttemptAt: null, eventType: "new_reservation" },
    ]);
    expect(plan.markProcessed).toEqual([
      { staffId: "a", providerMessageId: "m1", eventType: "new_reservation" },
      { staffId: "b", providerMessageId: "m2", eventType: "cancellation" },
    ]);
    expect(plan.leaveForLegacy).toEqual([{ staffId: "b", providerMessageId: "m1" }]);
    expect(plan.holdStaff).toEqual(["c"]);
  });
});
