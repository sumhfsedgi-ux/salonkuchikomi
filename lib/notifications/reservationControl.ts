import { resolveFeatureStates, type ReservationSwitchSnapshot, type SetupContext } from "@/lib/features/featureState";
import type { CustomerStartResult } from "@/lib/notifications/db/operations";

// お客様による予約通知の開始・再開(app/dashboard/notifications/actions.ts から呼ぶ。DB の操作は deps で受け取る)。
// どちらも、その時点の状態をサーバーで計算し直してから行う。内部スイッチは、確かめたときに読んだ値のままのときだけ ON にする
// (確かめたあとに「利用を停止する」が入っていたら書かない)。メール確認・送信をするかは、今まで通り DB が毎回、
// 運用状態・契約・受信の ON/OFF・内部スイッチをそろって確かめて決める(ここでは運用状態を直接変えない)。

export interface ReservationControlDeps {
  loadContext: () => Promise<SetupContext>;
  turnOnSwitch: (expected: ReservationSwitchSnapshot | null) => Promise<boolean>;
  /** reservation_ops_customer_start(旧サービスの店舗・運営の停止・契約・スイッチ・Gmail・LINE を DB が確かめる)。 */
  customerStart: () => Promise<CustomerStartResult>;
}

export type ReservationControlResult = { ok: true } | { ok: false; error: string };

export const STATE_CHANGED_ERROR = "予約通知の状態が変わりました。画面を更新して、もう一度ご確認ください。";

const START_ERRORS: Record<Exclude<CustomerStartResult, "started" | "already_active">, string> = {
  legacy_salon: "この店舗の予約通知は運営側で開始します。お客様の操作は不要です。",
  paused_by_operator: "予約通知は運営側で停止中です。お問い合わせください。",
  entitlement_hold: "予約通知は運営側で停止中です。お問い合わせください。",
  plan_not_allowed: "この機能はご契約に含まれていません。",
  // スイッチを ON にしたあと、開始までの間に「利用を停止する」が入った場合。
  not_selected: STATE_CHANGED_ERROR,
  gmail_not_connected: "先にGoogleと連携してください。",
  no_line_recipients: "LINEの送信先が登録されていません。",
};

function reservationStatus(ctx: SetupContext) {
  return resolveFeatureStates(ctx).states.find((s) => s.key === "reservation_notifications")!.status;
}

/**
 * 初回の開始(旧サービスを使っていない店舗が、Google と LINE の設定を終えたあと)。
 * 開始できなかった場合もスイッチは ON のまま残る。これはチェックボックスで予約通知を選び、まだ開始していない店舗と
 * 同じ状態で、運用状態が稼働中にならない限り、メール確認・送信の対象にならない(scripts/testdb/features-onboarding.test.ts)。
 */
export async function startReservation(deps: ReservationControlDeps): Promise<ReservationControlResult> {
  const ctx = await deps.loadContext();
  if (reservationStatus(ctx) !== "ready_to_start") return { ok: false, error: STATE_CHANGED_ERROR };
  if (ctx.reservationSwitch?.selected !== true && !(await deps.turnOnSwitch(ctx.reservationSwitch))) {
    return { ok: false, error: STATE_CHANGED_ERROR };
  }
  const result = await deps.customerStart();
  if (result === "started" || result === "already_active") return { ok: true };
  return { ok: false, error: START_ERRORS[result] };
}

/**
 * 「予約通知の利用を停止する」で止めた店舗の再開。スイッチを ON に戻すだけで、運用状態・旧側の停止確認・
 * 受信の ON/OFF・運営の停止には触れない(運営の停止中・確認中・再接続が必要なときは、停止中より先にその状態になるため再開できない)。
 */
export async function resumeReservation(deps: ReservationControlDeps): Promise<ReservationControlResult> {
  const ctx = await deps.loadContext();
  if (reservationStatus(ctx) !== "stopped") return { ok: false, error: STATE_CHANGED_ERROR };
  if (!(await deps.turnOnSwitch(ctx.reservationSwitch))) return { ok: false, error: STATE_CHANGED_ERROR };
  return { ok: true };
}
