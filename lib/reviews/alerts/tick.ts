import { runAutoSync, type AutoSyncSummary } from "@/lib/gbp/autoSync";
import type { GbpInbox } from "@/lib/gbp/inbox";
import { CRON_RUN_BUDGET_MS, createDeadline, type Deadline } from "@/lib/notifications/jobs/runBudget";
import { withDbTimeLimit } from "@/lib/notifications/dbTimeLimit";
import {
  deliverReviewAlerts,
  evaluateReviewAlerts,
  type DeliverSummary,
  type EvaluateSummary,
  type ReviewAlertSender,
} from "@/lib/reviews/alerts/deliver";
import { syncNotificationRegistrations, type NotificationSettingApi, type RegistrationSummary } from "@/lib/gbp/notificationSetting";
import type { GbpAccess } from "@/lib/gbp/access";
import type { AlertDeliveryStore, AutoSyncStore, PushStore } from "@/lib/reviews/alerts/store";

// 口コミの定期処理1回分(外部のスケジューラーから5分ごと。app/api/cron/reviews/tick/route.ts)。
//   ① 第2段階の記録の期限切れの削除(利用可否・通知の停止・連携・フラグに関係なく必ず行う)
//   ② 利用許可(google_reviews)が無くなった店舗の LINE 通知を止める(トリガーの補い)
//   ②' Google の通知設定の登録・解除(GBP_PUBSUB_ENABLED。LINE 通知を開始・停止した店舗の GBP アカウント)
//   ③ 自動取得(GBP_AUTO_SYNC_ENABLED。第1段階の同期。新しい口コミはイベントになる)
//   ④ イベントの評価と ⑤ 配信(REVIEW_ALERTS_ENABLED)
// 段ごとに失敗を分け、ある段の失敗で次の段を止めない(①は毎回必ず試みる)。配信には時間を残しておく。

/** 配信のために残しておく時間(自動取得はこれを使わない)。 */
const DELIVERY_RESERVE_MS = 12_000;

export interface ReviewTickDeps {
  store: AutoSyncStore & AlertDeliveryStore & Pick<PushStore, "purgePush">;
  /** 自動取得に使う第1段階の同期。Google口コミの処理を作れない(フラグが空・鍵が無い)なら null。 */
  inbox: Pick<GbpInbox, "syncForSchedule"> | null;
  flags: { autoSync: boolean; alerts: boolean };
  /** 確認用のリンクの元(NEXT_PUBLIC_APP_URL のオリジン)。無ければ評価しない。 */
  baseUrl: string | null;
  consentVersion: string;
  send: ReviewAlertSender;
  quotaAllows?: () => Promise<boolean>;
  /** Google の通知を受けているアカウント(0034)。 */
  pushActiveAccounts?: () => Promise<ReadonlySet<string>>;
  /** Google の通知設定の登録・解除(GBP_PUBSUB_ENABLED とトピックがあるときだけ)。 */
  registration?: {
    store: Pick<PushStore, "registrationWork" | "setRegistration">;
    api: NotificationSettingApi;
    access: Pick<GbpAccess, "binding" | "accessToken">;
    topic: string;
  } | null;
  deadline?: Deadline;
}

export interface ReviewTickSummary {
  purged: Record<string, number> | null;
  entitlementStops: number | null;
  registration: RegistrationSummary | null;
  autoSync: AutoSyncSummary | null;
  evaluate: EvaluateSummary | null;
  deliver: DeliverSummary | null;
  errors: string[];
}

export async function runReviewTick(deps: ReviewTickDeps): Promise<ReviewTickSummary> {
  const deadline = deps.deadline ?? createDeadline(CRON_RUN_BUDGET_MS);
  return withDbTimeLimit(() => deadline.hardRemainingMs() - 1_000, () => tick(deps, deadline));
}

async function tick(deps: ReviewTickDeps, deadline: Deadline): Promise<ReviewTickSummary> {
  const summary: ReviewTickSummary = {
    purged: null,
    entitlementStops: null,
    registration: null,
    autoSync: null,
    evaluate: null,
    deliver: null,
    errors: [],
  };
  const startedAt = new Date().toISOString();
  const stage = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      summary.errors.push(name);
      console.warn(`reviews tick: ${name} failed`, error instanceof Error ? error.name : "error");
      return null;
    }
  };

  summary.purged = await stage("purge", async () => ({ ...(await deps.store.purge()), pushMessages: await deps.store.purgePush() }));
  summary.entitlementStops = await stage("entitlement", () => deps.store.sweepEntitlement());

  if (deps.registration && deps.inbox) {
    const registration = deps.registration;
    summary.registration = await stage("registration", () =>
      syncNotificationRegistrations({ ...registration, deadline: deadline.child(Math.max(0, deadline.remainingMs() - 2 * DELIVERY_RESERVE_MS)) }),
    );
  }

  if (deps.flags.autoSync && deps.inbox) {
    const inbox = deps.inbox;
    const pushActive = deps.pushActiveAccounts ? await stage("push_state", () => deps.pushActiveAccounts!()) : null;
    summary.autoSync = await stage("auto_sync", () =>
      runAutoSync({
        store: deps.store,
        inbox,
        consentVersion: deps.consentVersion,
        deadline: deadline.child(Math.max(0, deadline.remainingMs() - DELIVERY_RESERVE_MS)),
        pushActive: pushActive ? (id) => pushActive.has(id) : undefined,
      }),
    );
  }

  if (deps.flags.alerts) {
    if (deps.baseUrl) {
      const baseUrl = deps.baseUrl;
      summary.evaluate = await stage("evaluate", () =>
        evaluateReviewAlerts({ store: deps.store, baseUrl, consentVersion: deps.consentVersion, deadline }),
      );
    } else {
      summary.errors.push("base_url_missing");
    }
    summary.deliver = await stage("deliver", () =>
      deliverReviewAlerts({ store: deps.store, send: deps.send, consentVersion: deps.consentVersion, deadline, quotaAllows: deps.quotaAllows }),
    );
  }

  await stage("record", () =>
    deps.store.recordRun(startedAt, {
      purgedDeliveries: summary.purged?.deliveries ?? 0,
      synced: summary.autoSync?.attempted ?? 0,
      syncFailed: summary.autoSync?.failed ?? 0,
      evaluated: summary.evaluate?.evaluated ?? 0,
      sent: summary.deliver?.sent ?? 0,
      unknown: summary.deliver?.unknown ?? 0,
      failed: summary.deliver?.failed ?? 0,
      errors: summary.errors.join(","),
    }),
  );
  return summary;
}
