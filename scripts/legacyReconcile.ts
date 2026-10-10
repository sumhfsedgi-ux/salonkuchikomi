// 旧サービス(hmail)からの切り替えで使う、送信状態の照合と切り戻しの判断(DBに触れない純粋な関数)。
// scripts/notifications-ops/core.ts から使う。単体テスト: __tests__/scripts/legacyReconcile.test.ts。
//
// hmail はスタッフ1人ごとに別々の salon 行・Gmail 接続を持ち、それぞれが同じ受信箱を独立に処理する。
// 処理の順番は: クレーム(processed_emails)→ 本文取得 → 種別の記録 → 通知設定の確認(OFF なら
// skipped_disabled)→ LINE 未連携なら failed "LINE未連携" → 送信 → 履歴(notification_history)。
// 履歴の記録の失敗は握りつぶされるため、「クレーム済みで履歴が無い」は送信済みかどうか分からない。
// processed_emails の単純な和集合では、スタッフ全員への配信完了を判断しない(メール×スタッフで判断する)。

export const LINE_NOT_LINKED_MESSAGE = "LINE未連携";

export interface HmailHistoryEntry {
  status: string;
  errorMessage: string | null;
  lineText: string | null;
  eventType: string;
}

export interface HmailStaffEmailState {
  staffId: string;
  providerMessageId: string;
  /** その スタッフの hmail.processed_emails の行(無ければ、そのスタッフ向けには一度も処理していない)。 */
  processed: { eventType: string; processedAt: string } | null;
  history: HmailHistoryEntry[];
}

export type StaffOutcome =
  | { kind: "handover" }
  | { kind: "not_hotpepper" }
  | { kind: "sent"; lineText: string | null; eventType: string }
  | { kind: "skipped"; reason: string; eventType: string }
  | { kind: "needs_review"; reason: string; eventType: string };

/** メール×スタッフ1組の、旧側での状態。結果不明を未送信として扱わない。 */
export function mapStaffEmail(state: HmailStaffEmailState): StaffOutcome {
  if (!state.processed) return { kind: "handover" };
  if (state.processed.eventType === "not_hotpepper") return { kind: "not_hotpepper" };
  const eventType = state.processed.eventType === "pending" ? "unknown" : state.processed.eventType;

  const sent = state.history.find((h) => h.status === "sent");
  if (sent) return { kind: "sent", lineText: sent.lineText, eventType };

  const uncertain = state.history.find(
    (h) => (h.status === "failed" && h.errorMessage !== LINE_NOT_LINKED_MESSAGE) || h.status === "unknown"
  );
  if (uncertain) return { kind: "needs_review", reason: `legacy_${uncertain.status}`, eventType };

  const skipped = state.history.find(
    (h) => h.status === "skipped_disabled" || (h.status === "failed" && h.errorMessage === LINE_NOT_LINKED_MESSAGE)
  );
  if (skipped) {
    return { kind: "skipped", reason: skipped.status === "skipped_disabled" ? "legacy_skipped_disabled" : "legacy_line_not_linked", eventType };
  }

  // クレーム済みで履歴が無い: 送信の直前・直後で止まった可能性がある(結果不明)。
  return {
    kind: "needs_review",
    reason: state.processed.eventType === "pending" ? "legacy_pending_without_history" : "legacy_classified_without_history",
    eventType,
  };
}

export interface EmailReconciliation {
  providerMessageId: string;
  outcomes: Map<string, StaffOutcome>;
  /** 対象スタッフ全員について旧側で決着している(引き継ぎが不要)。 */
  fullyHandled: boolean;
  notHotpepper: boolean;
  eventType: string;
  earliestProcessedAt: string | null;
}

export function reconcileEmail(
  providerMessageId: string,
  states: HmailStaffEmailState[],
  targetStaffIds: string[]
): EmailReconciliation {
  const outcomes = new Map<string, StaffOutcome>();
  for (const staffId of targetStaffIds) {
    const state = states.find((s) => s.staffId === staffId) ?? { staffId, providerMessageId, processed: null, history: [] };
    outcomes.set(staffId, mapStaffEmail(state));
  }
  const values = [...outcomes.values()];
  const notHotpepper = values.some((o) => o.kind === "not_hotpepper");
  const eventType =
    values.map((o) => ("eventType" in o ? o.eventType : null)).find((e) => e && e !== "unknown") ??
    values.map((o) => ("eventType" in o ? o.eventType : null)).find(Boolean) ??
    "unknown";
  const processedTimes = states.map((s) => s.processed?.processedAt).filter((t): t is string => Boolean(t)).sort();
  return {
    providerMessageId,
    outcomes,
    fullyHandled: notHotpepper || values.every((o) => o.kind !== "handover"),
    notHotpepper,
    eventType,
    earliestProcessedAt: processedTimes[0] ?? null,
  };
}

export function summarize(reconciliations: EmailReconciliation[]): Record<string, number> {
  const counts: Record<string, number> = { emails: reconciliations.length, sent: 0, skipped: 0, needs_review: 0, handover: 0, not_hotpepper_emails: 0, partially_handled_emails: 0 };
  for (const r of reconciliations) {
    if (r.notHotpepper) {
      counts.not_hotpepper_emails++;
      continue;
    }
    if (!r.fullyHandled) counts.partially_handled_emails++;
    for (const o of r.outcomes.values()) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  }
  return counts;
}

// ---- 切り戻し(新側が送信を試みた後)----

export interface NewSideDelivery {
  providerMessageId: string;
  lineConnectionId: string;
  status: string;
  origin: "salonpack" | "hmail";
  firstAttemptAt: string | null;
  eventType: string;
}

export interface RollbackPlan {
  /** 旧側(hmail)の処理済みとして登録する(メール×スタッフ。メール全体ではない)。 */
  markProcessed: Array<{ staffId: string; providerMessageId: string; eventType: string }>;
  /** 結果不明・確認待ちがあるため、解決するまで旧側を再開しないスタッフ。 */
  holdStaff: string[];
  /** 新側で送っていない(旧側が送るべき)組。 */
  leaveForLegacy: Array<{ staffId: string; providerMessageId: string }>;
}

/**
 * 新側が扱ったメールを、旧側の処理済みとして登録するかどうかをメール×スタッフごとに決める。
 *   送信済み・送らないと決めたもの(skipped)→ 旧側でも処理済みにする(旧側から再送させない)
 *   一度も送信を試みていないもの → 登録しない(旧側が送る)
 *   結果不明・確認待ち → 登録もしないし、そのスタッフの旧側の再開も保留する
 */
export function buildRollbackPlan(deliveries: NewSideDelivery[]): RollbackPlan {
  const plan: RollbackPlan = { markProcessed: [], holdStaff: [], leaveForLegacy: [] };
  const hold = new Set<string>();
  for (const d of deliveries) {
    if (d.origin !== "salonpack") continue;
    const pair = { staffId: d.lineConnectionId, providerMessageId: d.providerMessageId };
    if (d.status === "sent" || d.status === "skipped") {
      plan.markProcessed.push({ ...pair, eventType: d.eventType });
    } else if (d.status === "pending" || (d.status === "retry_wait" && !d.firstAttemptAt) || d.status === "failed") {
      plan.leaveForLegacy.push(pair);
    } else {
      // unknown / claimed / needs_review / 送信を試みた retry_wait
      hold.add(d.lineConnectionId);
    }
  }
  plan.holdStaff = [...hold];
  return plan;
}
