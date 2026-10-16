import { GBP_MIN_REFRESH_INTERVAL_MS, type GbpInbox, type ScheduledSyncResult } from "@/lib/gbp/inbox";
import type { Deadline } from "@/lib/notifications/jobs/runBudget";
import type { AutoSyncOutcome, AutoSyncStore, DueLocation } from "@/lib/reviews/alerts/store";

// 口コミの自動取得(第2段階)。画面を開いていなくても、期限の来た店舗の口コミを、第1段階の同期(lib/gbp/inbox.ts)で取り込む。
//   ・対象は DB で絞る(利用可否 google_reviews・今の版の同意・口コミの結び付け・アカウントの認証状態・同期の処理権)。
//     同期の入口(syncForSchedule)も、同意・連携・店舗の選択を確かめ直す。
//   ・新しい口コミは、取り込み(gbp_ingest_reviews)の索引のトリガーがイベントにする(手動の［更新］と同じ)。ここでは通知しない。
//   ・手動の［更新］と同じ処理権・同じ最短の間隔(5分)の判定を共有する。Google の通知を受けた店舗だけは間隔を待たない。
//   ・refresh token の失効(invalid_grant)は、自動取得の記録(gbp_auto_auth_holds)にだけ残す。アカウントの認証状態
//     (google_record_auth_result)は変えない(予約通知の Gmail の判定・停止の記録・連絡に影響させない。lib/gbp/access.ts)。
//   ・締切までに始められなかった店舗は、失敗にせず次の回へ回す。

/** Google の通知が使えないアカウントの間隔(15分)。 */
export const AUTO_SYNC_INTERVAL_SECONDS = 15 * 60;
/** Google の通知を受けているアカウントの、取りこぼしの補いの間隔(60分)。 */
export const AUTO_SYNC_PUSH_INTERVAL_SECONDS = 60 * 60;
/** 処理権が取れなかった(手動の更新・ほかの処理の途中)ときに、もう一度確かめるまでの時間。 */
const BUSY_RETRY_SECONDS = 60;
/** 1店舗の同期に使う時間の上限(第1段階の同期の締切 + 記録の余裕)。これより残りが少なければ次の店舗を始めない。 */
export const AUTO_SYNC_SLICE_MS = 22_000;

export interface AutoSyncDeps {
  store: AutoSyncStore;
  inbox: Pick<GbpInbox, "syncForSchedule">;
  consentVersion: string;
  deadline: Deadline;
  /** そのアカウントで Google の通知を受けているか(0034。無ければ定期の確認だけ)。 */
  pushActive?: (googleAccountId: string) => boolean;
  limit?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface AutoSyncSummary {
  due: number;
  attempted: number;
  complete: number;
  partial: number;
  skipped: number;
  failed: number;
  deferred: number;
  authHolds: number;
}

function outcomeOf(result: ScheduledSyncResult): AutoSyncOutcome {
  if (result.kind === "not_ready") return "inactive";
  return result.kind;
}

export async function runAutoSync(deps: AutoSyncDeps): Promise<AutoSyncSummary> {
  const summary: AutoSyncSummary = { due: 0, attempted: 0, complete: 0, partial: 0, skipped: 0, failed: 0, deferred: 0, authHolds: 0 };
  const log = deps.log ?? (() => {});
  if (!deps.deadline.allows(AUTO_SYNC_SLICE_MS)) return summary;
  const due = await deps.store.dueLocations(deps.consentVersion, deps.limit ?? 50);
  summary.due = due.length;
  /** この回で refresh token の失効が分かったアカウント(同じアカウントの別の店舗では、もう呼ばない)。 */
  const invalidAccounts = new Set<string>();

  for (const loc of due) {
    if (!deps.deadline.allows(AUTO_SYNC_SLICE_MS)) {
      summary.deferred++;
      continue;
    }
    if (invalidAccounts.has(loc.googleAccountId)) {
      summary.skipped++;
      continue;
    }
    await syncOne(deps, loc, summary, invalidAccounts, log);
  }
  return summary;
}

async function syncOne(
  deps: AutoSyncDeps,
  loc: DueLocation,
  summary: AutoSyncSummary,
  invalidAccounts: Set<string>,
  log: NonNullable<AutoSyncDeps["log"]>,
): Promise<void> {
  const interval = deps.pushActive?.(loc.googleAccountId) ? AUTO_SYNC_PUSH_INTERVAL_SECONDS : AUTO_SYNC_INTERVAL_SECONDS;
  const startedAt = await deps.store.beginAutoSync(loc.salonId, loc.locationId);
  summary.attempted++;
  let result: ScheduledSyncResult;
  try {
    result = await deps.inbox.syncForSchedule(loc.salonId, {
      // Google の通知を受けた店舗は、手動の更新の直後でも取りに行く。定期の確認は最短の間隔を守る。
      minIntervalMs: loc.requested ? 0 : GBP_MIN_REFRESH_INTERVAL_MS,
      detectedVia: loc.requested ? "pubsub" : "reconcile",
    });
  } catch {
    result = { kind: "failed", failure: "unavailable", tokenInvalid: false };
  }

  const outcome = outcomeOf(result);
  let errorKind: string | null = null;
  if (result.kind === "failed") {
    summary.failed++;
    errorKind = result.failure;
    if (result.tokenInvalid) {
      invalidAccounts.add(loc.googleAccountId);
      const failures = await deps.store.recordAuth(loc.googleAccountId, loc.tokenGeneration, false);
      if (failures >= 2) summary.authHolds++;
      log("auth_failed", { failures });
    }
  } else if (result.kind === "complete" || result.kind === "partial") {
    if (result.kind === "complete") summary.complete++;
    else summary.partial++;
    await deps.store.recordAuth(loc.googleAccountId, loc.tokenGeneration, true);
  } else {
    summary.skipped++;
  }

  await deps.store.finishAutoSync({
    locationId: loc.locationId,
    outcome,
    attemptStartedAt: startedAt,
    // 途中の同期の続きは、通知を受ける前に始まっていたかもしれない(最初から読み直した同期だけで、通知を済みにする)。
    freshRun: !loc.runInProgress,
    nextSeconds: outcome === "busy" ? BUSY_RETRY_SECONDS : interval,
    errorKind,
  });
}
