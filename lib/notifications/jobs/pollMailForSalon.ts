import { claimMessageForProcessing, filterUnclaimed, reclaimStuckEmail, releaseEmailClaim } from "@/lib/notifications/db/processedEmails";
import { recordNotification } from "@/lib/notifications/db/notificationHistory";
import { classifyEmail, dbDeliveryStore, type DeliveryStore } from "@/lib/notifications/db/notificationDeliveries";
import { pauseReservationNotifications } from "@/lib/notifications/db/operations";
import type { LineConnection } from "@/lib/notifications/db/lineConnections";
import { withDbTimeLimit } from "@/lib/notifications/dbTimeLimit";
import { detectEmail } from "@/lib/notifications/hotpepper/detectEmail";
import { parseReservation } from "@/lib/notifications/hotpepper/parseReservation";
import { formatLineMessage } from "@/lib/notifications/hotpepper/formatLineMessage";
import { MailProviderError, type MailProvider } from "@/lib/notifications/mail/MailProvider";
import { scanCandidates, type ScanStore } from "@/lib/notifications/mail/gmailScan";
import { LineSendError, type LineSendOptions, type LineSendResult } from "@/lib/notifications/line/LineClient";
import {
  callTimeout,
  createDeadline,
  GMAIL_CALL_TIMEOUT_MS,
  GMAIL_MIN_CALL_MS,
  GMAIL_RECORD_MARGIN_MS,
  LINE_MIN_SEND_MS,
  LINE_SEND_TIMEOUT_MS,
  MIN_DB_CALL_MS,
  PRE_SEND_RESERVE_MS,
  SEND_RECORD_MARGIN_MS,
  SEND_START_MS,
  type Deadline,
} from "@/lib/notifications/jobs/runBudget";

// 1店舗分・1回の定期処理。締切(deps.deadline)までに終わる処理だけを始める。
//   段階1(取得・分類): Gmail を続きから読み、まだクレームされていないメールを1通ずつ、
//     クレーム → 本文の取得 → 分類と送信先ごとの配信行の作成(notifications_classify_email、1トランザクション)
//     の順に処理する。時間が足りなければ次のメールをクレームせずに止める(先にまとめてクレームしない。
//     手を付けていないメールは未処理のまま次回へ回り、失敗として数えない)。締切に合わせて縮めたタイムアウトで
//     本文の取得が打ち切られた・本文のあとに分類の時間が無い場合も、失敗として数えずにクレームを戻す。
//   段階2(配信): 配信を処理権付きで1件ずつ取り出し、送信直前に DB で運用状態・契約・全体スイッチ・
//     スタッフのON/OFF・送信先と登録の世代・遅延通知のルールを確かめてから、同じ retry key で送る。
//     - DB への問い合わせは、全体の残り時間で打ち切る(lib/notifications/dbTimeLimit.ts)。送信前の問い合わせは、
//       LINE への送信と記録の時間を残した長さまで
//     - 問い合わせの応答が遅れて届き、送信の時間が残っていなければ LINE を呼ばない。送信前なので未送信と
//       断定して戻す(取り出しのあと: releaseClaim / 送信直前の確認のあと: cancelSendStart)
//     - 問い合わせが打ち切られた(DB に反映されたか分からない)・戻す問い合わせが失敗した場合は、LINE を呼ばずに
//       止める。処理権の期限のあと結果不明として扱われ、同じ retry key で再試行される(未送信とは書き換えない)
//     - LINE の応答待ちを締切に合わせて縮めた結果のタイムアウトは「結果不明」で、同じ retry key で後から再試行する
//     - 送信のあとの結果の記録は上限(強制終了の前)までに行う。履歴(notification_history)は締切を過ぎたら省く
//   段階1には店舗の時間の半分まで(配信の時間を残す)。
// 呼び出し元(pollMailForAllSalons)は、運用状態が稼働中の店舗だけを渡す。

export interface PollDependencies {
  provider: MailProvider;
  scanStore: ScanStore;
  sendLine: (destinationId: string, text: string, retryKey: string, options?: LineSendOptions) => Promise<LineSendResult>;
  /** 予約通知を含む契約プラン(lib/access/plan.ts の plansIncluding)。 */
  allowedPlans: string[];
  now?: () => Date;
  maxDeliveriesPerTick?: number;
  maxBacklogPages?: number;
  /** この店舗に使ってよい時間(省略時は定期処理1回分)。 */
  deadline?: Deadline;
  /** テスト用: 配信の DB 操作(遅延・失敗の再現)。省略時は本物。 */
  deliveryStore?: DeliveryStore;
  /** テスト用: 履歴の記録。省略時は本物。 */
  recordHistory?: typeof recordNotification;
}

export interface PollSalonParams {
  salonId: string;
  accountId: string;
  initialWatermark: Date;
  /** 配信行の作成に使う、この店舗の LINE 送信先(接続済みで送信先IDがあるものだけを使う)。 */
  recipients: LineConnection[];
  /** false: Gmail を読まない(予約メールの権限が足りない間。作成済みの配信は送る)。 */
  readMail?: boolean;
}

export interface PollResult {
  scanned: boolean;
  claimed: number;
  classified: number;
  delivered: number;
  deliveryFailed: number;
  deliveryUnknown: number;
  skipped: number;
  needsReview: number;
  /** 認可そのものの失効(アカウント単位で数えるため、呼び出し元へ返す)。 */
  authFailure: "invalid_grant" | null;
  /** 予約メール(Gmail)の権限だけが足りない(その店舗の結び付けに記録する。アカウントの失敗としては数えない)。 */
  scopeMissing: boolean;
  quotaExceeded: boolean;
  pausedForLegacy: boolean;
  /** 締切のため、残りを次回へ回した(失敗ではない)。 */
  stoppedForTime: boolean;
  /** 読み残し・送り残しがある可能性(時間が余れば同じ回でもう一度処理してよい)。 */
  moreWork: boolean;
  /** 送信前に取りやめて、未送信と断定して戻した配信の数。 */
  releasedBeforeSend: number;
  /** LINE を呼ぶ前に送信が止められた(この環境では実際に送らない・設定不備)。配信は未送信のまま戻した。 */
  sendBlocked: boolean;
}

const DEFAULT_MAX_DELIVERIES_PER_TICK = 20;
const MAX_STUCK_RECLAIMS_PER_TICK = 5;
const QUOTA_RETRY_SECONDS = 60 * 60;
const DEFAULT_SALON_BUDGET_MS = 45_000;
/** 上限(強制終了)の手前に残す時間。 */
const HARD_LIMIT_MARGIN_MS = 1_000;

type StopReason = "insufficient_scope" | "invalid_grant";

function stopReasonOf(error: unknown): StopReason | null {
  if (error instanceof MailProviderError && (error.kind === "insufficient_scope" || error.kind === "invalid_grant")) return error.kind;
  return null;
}

/** 失敗しても処理を止めない問い合わせ(後片付け・履歴)。結果は戻り値で返す。 */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

export async function pollMailForSalon(params: PollSalonParams, deps: PollDependencies): Promise<PollResult> {
  const result: PollResult = {
    scanned: false,
    claimed: 0,
    classified: 0,
    delivered: 0,
    deliveryFailed: 0,
    deliveryUnknown: 0,
    skipped: 0,
    needsReview: 0,
    authFailure: null,
    scopeMissing: false,
    quotaExceeded: false,
    pausedForLegacy: false,
    stoppedForTime: false,
    moreWork: false,
    releasedBeforeSend: 0,
    sendBlocked: false,
  };
  const deadline = deps.deadline ?? createDeadline(DEFAULT_SALON_BUDGET_MS);
  const store = deps.deliveryStore ?? dbDeliveryStore;
  const recordHistory = deps.recordHistory ?? recordNotification;
  /** 結果の記録・後片付け: 上限(強制終了)の手前まで。 */
  const hardLimit = () => deadline.hardRemainingMs() - HARD_LIMIT_MARGIN_MS;
  /** 履歴(画面用。正は notification_deliveries): 締切の内側でだけ書く。 */
  const writeHistory = async (entry: Parameters<typeof recordNotification>[0]) => {
    if (deadline.remainingMs() < MIN_DB_CALL_MS) return;
    await attempt(() => withDbTimeLimit(() => deadline.remainingMs(), () => recordHistory(entry)));
  };
  const recipients = params.recipients
    .filter((r) => r.status === "connected" && r.destinationId)
    .map((r) => ({ lineConnectionId: r.id, destinationId: r.destinationId! }));

  const stop = (reason: StopReason) => {
    if (reason === "insufficient_scope") result.scopeMissing = true;
    else result.authFailure = "invalid_grant";
  };

  // ---- 段階1: 取得・クレーム・分類(店舗の時間の半分まで。配信の時間を残す) ----
  if (params.readMail !== false) {
    const stage1 = deadline.child(Math.max(0, Math.min(deadline.remainingMs() / 2, deadline.remainingMs() - SEND_START_MS)));
    const gmailTimeout = () => callTimeout(stage1, GMAIL_CALL_TIMEOUT_MS, GMAIL_MIN_CALL_MS, GMAIL_RECORD_MARGIN_MS);
    const stage1Limit = () => stage1.remainingMs();
    // 続きの保存・リースの解放は後片付けなので、上限まで待ってよい。
    const scanStore: ScanStore = {
      acquire: (p) => withDbTimeLimit(stage1Limit, () => deps.scanStore.acquire(p)),
      progress: (p) => withDbTimeLimit(hardLimit, () => deps.scanStore.progress(p)),
    };

    /**
     * クレーム済みの1通を、本文の取得 → 分類と配信行の作成まで進める。権限・認可の問題なら止める理由、
     * 締切のために打ち切ったら "out_of_time"(クレームは失敗として数えずに戻す)を返す。
     */
    async function classifyOne(processedId: string, messageId: string, timeoutMs: number): Promise<StopReason | "out_of_time" | null> {
      const releaseAndStop = async () => {
        await attempt(() => withDbTimeLimit(hardLimit, () => releaseEmailClaim(processedId)));
        return "out_of_time" as const;
      };
      try {
        const email = await deps.provider.getMessage(messageId, { timeoutMs });
        // 本文の応答が遅れて届き、分類を記録する時間が無い: 失敗として数えずにクレームを戻す。
        if (stage1.remainingMs() < MIN_DB_CALL_MS) return await releaseAndStop();
        const detection = detectEmail(email);
        if (!detection.isHotPepper) {
          await withDbTimeLimit(stage1Limit, () =>
            classifyEmail({ processedId, eventType: "not_hotpepper", lineText: null, mailReceivedAt: email.receivedAt, recipients: [] })
          );
          return null;
        }
        const text = formatLineMessage(parseReservation(email.bodyText, detection.eventType));
        await withDbTimeLimit(stage1Limit, () =>
          classifyEmail({ processedId, eventType: detection.eventType, lineText: text, mailReceivedAt: email.receivedAt, recipients })
        );
        result.classified++;
        return null;
      } catch (error) {
        const reason = stopReasonOf(error);
        if (reason) return reason; // pending のまま残る(権限が戻ったあと、滞留メールの再クレームで拾う)
        if (error instanceof MailProviderError && error.kind === "timeout" && timeoutMs < GMAIL_CALL_TIMEOUT_MS) {
          return await releaseAndStop();
        }
        // 一時的な失敗: pending のまま残り、後の回の滞留メール再クレームで拾う(上限回数で unprocessable)。
        console.error("[notifications] classify failed", {
          salonId: params.salonId,
          kind: error instanceof MailProviderError ? error.kind : "unexpected",
        });
        return null;
      }
    }

    let stopped = false;
    try {
      const scan = await scanCandidates({
        salonId: params.salonId,
        accountId: params.accountId,
        initialWatermark: params.initialWatermark,
        provider: deps.provider,
        store: scanStore,
        now: deps.now,
        maxBacklogPages: deps.maxBacklogPages,
        listTimeout: gmailTimeout,
        onPageIds: async (ids) => {
          const fresh = await withDbTimeLimit(stage1Limit, () => filterUnclaimed(params.salonId, ids));
          for (const messageId of fresh) {
            const timeoutMs = gmailTimeout();
            if (timeoutMs === null) {
              result.stoppedForTime = true;
              return false; // クレームせずに止める(このページの続きは保存しない)
            }
            const processedId = await withDbTimeLimit(stage1Limit, () => claimMessageForProcessing(params.salonId, messageId));
            if (!processedId) continue;
            result.claimed++;
            const outcome = await classifyOne(processedId, messageId, timeoutMs);
            if (outcome === "out_of_time") {
              result.stoppedForTime = true;
              return false;
            }
            if (outcome) {
              stop(outcome);
              stopped = true;
              return false;
            }
          }
          return true;
        },
      });
      if (scan.stoppedForTime) result.stoppedForTime = true;
      if (scan.leased && !scan.completedScan) result.moreWork = true;
      result.scanned = scan.leased && !stopped;
    } catch (error) {
      const reason = stopReasonOf(error);
      if (reason) {
        stop(reason);
        stopped = true;
      } else {
        // 一時的な障害・時間切れ: 今回の取得はここまで(続きは保存済み)。配信は続ける。
        console.error("[notifications] scan failed", { salonId: params.salonId, kind: error instanceof MailProviderError ? error.kind : "unexpected" });
      }
    }

    for (let i = 0; i < MAX_STUCK_RECLAIMS_PER_TICK && !stopped; i++) {
      const timeoutMs = gmailTimeout();
      if (timeoutMs === null) {
        result.stoppedForTime = true;
        result.moreWork = true;
        break;
      }
      const stuck = await attempt(() => withDbTimeLimit(stage1Limit, () => reclaimStuckEmail(params.salonId)));
      if (!stuck.ok || !stuck.value) break;
      const outcome = await classifyOne(stuck.value.id, stuck.value.providerMessageId, timeoutMs);
      if (outcome === "out_of_time") {
        result.stoppedForTime = true;
        result.moreWork = true;
        break;
      }
      if (outcome) {
        stop(outcome);
        stopped = true;
      }
    }
  }

  // ---- 段階2: 配信 ----
  /** 送信前の問い合わせ: LINE への送信と記録の時間を残した長さまで。 */
  const preSendLimit = () => deadline.remainingMs() - PRE_SEND_RESERVE_MS;
  const maxDeliveries = deps.maxDeliveriesPerTick ?? DEFAULT_MAX_DELIVERIES_PER_TICK;
  for (let i = 0; i < maxDeliveries; i++) {
    if (!deadline.allows(SEND_START_MS)) {
      result.stoppedForTime = true;
      result.moreWork = true;
      break;
    }
    const claimed = await attempt(() => withDbTimeLimit(preSendLimit, () => store.claim(params.salonId, deps.allowedPlans)));
    if (!claimed.ok) {
      // 取り出しが打ち切られた(DB で取り出されたかは分からない。取り出されていれば処理権の期限で元に戻る)。
      result.stoppedForTime = true;
      result.moreWork = true;
      break;
    }
    const delivery = claimed.value;
    if (!delivery) break;
    if (deadline.remainingMs() < PRE_SEND_RESERVE_MS + MIN_DB_CALL_MS) {
      // 取り出しの応答が遅れて届いた。まだ送信を始めていないので、未送信と断定して戻す。
      const released = await attempt(() => withDbTimeLimit(hardLimit, () => store.releaseClaim(delivery)));
      if (released.ok && released.value) result.releasedBeforeSend++;
      result.stoppedForTime = true;
      result.moreWork = true;
      break;
    }

    const begun = await attempt(() => withDbTimeLimit(preSendLimit, () => store.begin(delivery, deps.allowedPlans)));
    if (!begun.ok) {
      // 送信直前の確認が打ち切られた('send' が記録されたかは分からない)。LINE は呼ばない
      // (記録されていれば、処理権の期限のあと結果不明として同じ retry key で再試行される)。
      result.stoppedForTime = true;
      result.moreWork = true;
      break;
    }
    const decision = begun.value;
    if (decision.decision === "skipped") {
      result.skipped++;
      await writeHistory({
        salonId: params.salonId,
        lineConnectionId: decision.lineConnectionId,
        eventType: decision.eventType,
        providerMessageId: delivery.providerMessageId,
        status: "skipped_disabled",
        errorMessage: decision.reason,
      });
      continue;
    }
    if (decision.decision === "needs_review") {
      result.needsReview++;
      continue;
    }
    if (decision.decision === "released") {
      if (decision.reason.startsWith("legacy_")) {
        // 旧側(hmail)が再び動いている・確認できない: 二重通知を防ぐため、この店舗の送信を止める。
        await withDbTimeLimit(hardLimit, () =>
          pauseReservationNotifications({
            salonId: params.salonId,
            by: "system:legacy_watchdog",
            reason: decision.reason,
            kind: "legacy_active",
          })
        );
        result.pausedForLegacy = true;
        break;
      }
      if (decision.reason.startsWith("retry_suppressed") || decision.reason.startsWith("retry_stopped")) continue;
      break; // 店舗の条件(停止・契約・機能・全体スイッチ)を満たさない。残りも同じなので終える。
    }
    if (decision.decision !== "send") continue; // expired / lost

    // 締切に収まる長さで応答を待つ。送信直前の確認の応答が遅れて届き、最短の長さも収まらなければ LINE を呼ばない
    // (まだ送信していないので、未送信と断定して戻す)。
    const timeoutMs = callTimeout(deadline, LINE_SEND_TIMEOUT_MS, LINE_MIN_SEND_MS, SEND_RECORD_MARGIN_MS);
    if (timeoutMs === null) {
      const cancelled = await attempt(() => withDbTimeLimit(hardLimit, () => store.cancelSendStart(delivery)));
      if (cancelled.ok && cancelled.value) result.releasedBeforeSend++;
      result.stoppedForTime = true;
      result.moreWork = true;
      break;
    }

    let sendResult: LineSendResult;
    try {
      sendResult = await deps.sendLine(decision.destinationId, decision.lineText, decision.lineRetryKey, { timeoutMs });
    } catch (error) {
      if (error instanceof LineSendError) {
        // LINE を呼ぶ前に止められた(この環境では実際に送らない・設定不備)。未送信と断定して戻し、
        // この店舗の送信を終える(同じ理由で残りも送れないため、繰り返さない)。
        const cancelled = await attempt(() => withDbTimeLimit(hardLimit, () => store.cancelSendStart(delivery)));
        if (cancelled.ok && cancelled.value) result.releasedBeforeSend++;
        result.sendBlocked = true;
        break;
      }
      sendResult = { outcome: "unknown", reason: "client_error" };
    }

    const outcome =
      sendResult.outcome === "quota_exceeded" ? "retry_wait" : sendResult.outcome;
    const recorded = await attempt(() =>
      withDbTimeLimit(hardLimit, () =>
        store.finish({
          delivery,
          outcome,
          lineRequestId: sendResult.outcome === "sent" ? sendResult.requestId : null,
          error:
            sendResult.outcome === "failed"
              ? `http_${sendResult.status}`
              : sendResult.outcome === "unknown"
                ? sendResult.reason
                : sendResult.outcome === "quota_exceeded"
                  ? "monthly_quota_exceeded"
                  : sendResult.outcome === "retry_wait"
                    ? "rate_limited"
                    : null,
          retryAfterSeconds:
            sendResult.outcome === "retry_wait"
              ? sendResult.retryAfterSeconds
              : sendResult.outcome === "quota_exceeded"
                ? QUOTA_RETRY_SECONDS
                : undefined,
        })
      )
    );
    if (!recorded.ok) {
      // 結果を記録できなかった(処理権の期限のあと結果不明として扱われ、同じ retry key で再試行される)。
      result.moreWork = true;
      break;
    }
    if (!recorded.value) continue; // 処理権を失っていた(別の処理が結果不明として扱う)。履歴は書かない。

    if (sendResult.outcome === "sent") result.delivered++;
    else if (sendResult.outcome === "failed") result.deliveryFailed++;
    else result.deliveryUnknown++;

    await writeHistory({
      salonId: params.salonId,
      lineConnectionId: decision.lineConnectionId,
      eventType: decision.eventType,
      providerMessageId: delivery.providerMessageId,
      lineText: decision.lineText,
      status: sendResult.outcome === "sent" ? "sent" : sendResult.outcome === "failed" ? "failed" : "unknown",
      errorMessage:
        sendResult.outcome === "sent"
          ? undefined
          : sendResult.outcome === "failed"
            ? "LINEへの送信に失敗しました"
            : "LINEの受付を確認できませんでした(同じ内容で再試行します)",
    });

    if (sendResult.outcome === "quota_exceeded") {
      result.quotaExceeded = true;
      console.error("[notifications] LINE monthly quota exceeded; stopping deliveries for this tick");
      break;
    }
  }

  return result;
}
