import { LineSendBlockedError, LineSendError, type LineSendOptions, type LineSendResult } from "@/lib/notifications/line/LineClient";
import {
  LINE_MIN_SEND_MS,
  LINE_SEND_TIMEOUT_MS,
  MIN_DB_CALL_MS,
  PRE_SEND_RESERVE_MS,
  SEND_RECORD_MARGIN_MS,
  SEND_START_MS,
  callTimeout,
  type Deadline,
} from "@/lib/notifications/jobs/runBudget";
import type { AlertDeliveryStore, AlertMessageData } from "@/lib/reviews/alerts/store";

// 口コミの LINE 通知の評価と配信(第2段階)。予約通知の配信(lib/notifications/jobs/pollMailForSalon.ts)と同じ決まりで、
// 表と関数は口コミ専用(0033)。
//   評価: 新しい口コミのイベントごとに、DB でロックして「送るか・誰に送るか」を決め、通知先ごとの配信を作る。
//   配信: 取り出し → 送信直前の確認(停止・OFF・解除・再登録・利用許可・店舗の選び直し)→ LINE → 結果の記録。
//     ・送信を始めたら(send)、結果は sent / failed / unknown / retry_wait のどれかで記録する。結果が分からないものは
//       同じ retry key・同じ内容で再試行する(LINE 側で二重にならない)。送信の開始を取り消せない場合があることを前提にする
//     ・締切までに LINE を呼べない・この環境では送らない(LineSendBlockedError)ときは、送信の開始を取り消す(未送信)
//     ・月間の上限(429)なら、この回の口コミ通知の送信をやめ、1時間後に再試行する(予約通知の通数を残す)

export interface EvaluateDeps {
  store: Pick<AlertDeliveryStore, "pendingEvents" | "evaluate">;
  /** SalonPack の本番の URL(https://…。確認用のリンクに使う)。 */
  baseUrl: string;
  consentVersion: string;
  deadline: Deadline;
  limit?: number;
}

export interface EvaluateSummary {
  evaluated: number;
  notify: number;
  skipped: number;
  deferred: number;
}

export async function evaluateReviewAlerts(deps: EvaluateDeps): Promise<EvaluateSummary> {
  const summary: EvaluateSummary = { evaluated: 0, notify: 0, skipped: 0, deferred: 0 };
  if (!deps.deadline.allows(MIN_DB_CALL_MS * 2)) return summary;
  const events = await deps.store.pendingEvents(deps.limit ?? 100);
  for (const event of events) {
    if (!deps.deadline.allows(MIN_DB_CALL_MS * 2)) {
      summary.deferred++;
      continue;
    }
    const result = await deps.store.evaluate(event.id, deps.baseUrl, deps.consentVersion);
    summary.evaluated++;
    if (result === "notify") summary.notify++;
    else if (result.startsWith("skipped")) summary.skipped++;
  }
  return summary;
}

export type ReviewAlertSender = (
  destinationId: string,
  message: AlertMessageData,
  retryKey: string,
  options: LineSendOptions,
) => Promise<LineSendResult>;

export interface DeliverDeps {
  store: Omit<AlertDeliveryStore, "pendingEvents" | "evaluate" | "purge" | "sweepEntitlement">;
  send: ReviewAlertSender;
  consentVersion: string;
  deadline: Deadline;
  /** 月の残り通数に余裕があるか(無ければ口コミ通知だけ止める)。無ければ確かめない。 */
  quotaAllows?: () => Promise<boolean>;
  maxDeliveries?: number;
}

export interface DeliverSummary {
  sent: number;
  failed: number;
  unknown: number;
  retryWait: number;
  skipped: number;
  released: number;
  expired: number;
  lost: number;
  /** この環境では送らない(開発・テスト用DB・プレビュー・検証の宛先でない)ため、送信の開始を取り消した。 */
  blocked: number;
  quotaExceeded: boolean;
  quotaReserved: boolean;
}

const QUOTA_RETRY_SECONDS = 60 * 60;

export async function deliverReviewAlerts(deps: DeliverDeps): Promise<DeliverSummary> {
  const summary: DeliverSummary = {
    sent: 0,
    failed: 0,
    unknown: 0,
    retryWait: 0,
    skipped: 0,
    released: 0,
    expired: 0,
    lost: 0,
    blocked: 0,
    quotaExceeded: false,
    quotaReserved: false,
  };
  const { store, deadline } = deps;
  const max = deps.maxDeliveries ?? 50;
  let quotaChecked = false;

  for (let n = 0; n < max; n++) {
    if (!deadline.allows(SEND_START_MS)) break;
    const delivery = await store.claim();
    if (!delivery) break;

    // 取り出しのあとに残り時間が足りなければ、送らずに戻す(送信直前の確認の前なので未送信と断定できる)。
    if (!deadline.allows(PRE_SEND_RESERVE_MS + MIN_DB_CALL_MS)) {
      await store.releaseClaim(delivery);
      break;
    }
    if (!quotaChecked && deps.quotaAllows) {
      quotaChecked = true;
      if (!(await deps.quotaAllows())) {
        summary.quotaReserved = true;
        await store.releaseClaim(delivery);
        break;
      }
    }

    const begin = await store.beginSend(delivery, deps.consentVersion);
    if (begin.decision !== "send") {
      summary[begin.decision]++;
      continue;
    }

    const timeoutMs = callTimeout(deadline, LINE_SEND_TIMEOUT_MS, LINE_MIN_SEND_MS, SEND_RECORD_MARGIN_MS);
    if (timeoutMs === null) {
      await store.cancelSendStart(delivery);
      break;
    }

    let result: LineSendResult;
    try {
      result = await deps.send(begin.destinationId, begin.message, begin.retryKey, { timeoutMs });
    } catch (error) {
      if (error instanceof LineSendError) {
        // LINE を呼んでいない(この環境では送らない・設定の不備)。送信の開始を取り消して、この回はやめる。
        await store.cancelSendStart(delivery);
        if (error instanceof LineSendBlockedError) summary.blocked++;
        break;
      }
      // 想定外: 送ったかどうか分からない。同じ retry key で再試行する。
      await store.finish({ delivery, outcome: "unknown", error: "client_error" });
      summary.unknown++;
      continue;
    }

    switch (result.outcome) {
      case "sent":
        await store.finish({ delivery, outcome: "sent", lineRequestId: result.requestId });
        summary.sent++;
        break;
      case "failed":
        await store.finish({ delivery, outcome: "failed", error: `http_${result.status}` });
        summary.failed++;
        break;
      case "retry_wait":
        await store.finish({ delivery, outcome: "retry_wait", error: "rate_limited", retryAfterSeconds: result.retryAfterSeconds });
        summary.retryWait++;
        break;
      case "quota_exceeded":
        await store.finish({ delivery, outcome: "retry_wait", error: "monthly_limit", retryAfterSeconds: QUOTA_RETRY_SECONDS });
        summary.quotaExceeded = true;
        return summary;
      case "unknown":
        await store.finish({ delivery, outcome: "unknown", error: result.reason });
        summary.unknown++;
        break;
    }
  }
  return summary;
}
