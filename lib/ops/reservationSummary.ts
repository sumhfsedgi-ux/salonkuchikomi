import type { GoogleBindingSummary, ReservationOpsSummary } from "@/lib/ops/queries";

// 運営管理の「連携と稼働状況」に出す、予約通知の状態の要約(DBに触れない)。
// 内部の状態(運用状態・停止期間・スイッチ)をそのまま並べず、「通知しているか」と、止まっている理由をふつうの言葉で出す。
// 新しい仕組みでの送信の条件(notifications_list_pollable_salons・notifications_begin_send)と同じ項目を見る。

export type StopReasonKey =
  | "not_entitled"
  | "hold"
  | "not_started"
  | "awaiting_cutover"
  | "operator_paused"
  | "legacy_unconfirmed"
  | "master_off"
  | "customer_stopped"
  | "gmail_missing"
  | "gmail_reconnect"
  | "no_line_recipients";

export interface ReservationSummary {
  sending: boolean;
  reasons: Array<{ key: StopReasonKey; text: string }>;
}

export function summarizeReservation(input: {
  entitled: boolean;
  holdOpen: boolean;
  reservation: Pick<ReservationOpsSummary, "state" | "pauseReason" | "masterEnabled" | "customerSwitchOn" | "lineRecipients">;
  gmail: Pick<GoogleBindingSummary, "authState" | "scopeMissingSince"> | null;
}): ReservationSummary {
  const r = input.reservation;
  const reasons: ReservationSummary["reasons"] = [];
  const add = (key: StopReasonKey, text: string) => reasons.push({ key, text });

  if (!input.entitled) add("not_entitled", "この店舗では予約通知を使えない設定です(「契約と利用許可」を参照)。");
  if (input.holdOpen) add("hold", "権限による停止中です。再開するには、下の「停止を解除する」が必要です。");
  if (r.state === null || r.state === "setup_pending") add("not_started", "お客様がまだ予約通知を開始していません。");
  if (r.state === "awaiting_cutover") {
    add("awaiting_cutover", "旧サービスからの切り替え前です。運営が切り替えの作業を終えるまで、この仕組みからは通知しません。");
  }
  if (r.state === "paused") {
    if (r.pauseReason?.startsWith("legacy_")) add("legacy_unconfirmed", "旧サービスの状態を確認できないため、止めています。");
    else add("operator_paused", `運営が一時停止しています${r.pauseReason ? `(理由: ${r.pauseReason})` : ""}。`);
  }
  if (!r.masterEnabled) add("master_off", "お客様が予約通知の受信をOFFにしています。");
  if (r.customerSwitchOn === false) add("customer_stopped", "お客様が予約通知の利用を停止しています。");
  if (!input.gmail) add("gmail_missing", "予約受信用のGmailが連携されていません。");
  else if (input.gmail.authState !== "active" || input.gmail.scopeMissingSince) add("gmail_reconnect", "Google連携の再接続が必要です。");
  if (r.lineRecipients === 0) add("no_line_recipients", "LINEの通知先が登録されていません。");

  return { sending: r.state === "active" && reasons.length === 0, reasons };
}

/** 権限による停止を解除しても残る理由(解除の確認・結果の表示用)。 */
export function remainingAfterRelease(summary: ReservationSummary): string[] {
  return summary.reasons.filter((r) => r.key !== "hold" && r.key !== "not_entitled").map((r) => r.text);
}
