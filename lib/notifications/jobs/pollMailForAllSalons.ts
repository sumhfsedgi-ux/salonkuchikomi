import { isFeatureServedByMode } from "@/lib/appMode";
import { plansIncluding } from "@/lib/access/plan";
import { obtainGoogleAccessToken } from "@/lib/google/accessToken";
import type { GoogleOAuthConfig } from "@/lib/google/config";
import { getGoogleAccount, recordGoogleAuthResult, type AuthResult } from "@/lib/google/db/accounts";
import { listSalonsBoundToAccount, markBindingScope, recordConnectionEvent } from "@/lib/google/db/bindings";
import { classifyGoogleError } from "@/lib/google/errors";
import { logSafeError } from "@/lib/google/safeError";
import { hasScopeFor } from "@/lib/google/scopes";
import type { GoogleOAuthTransport } from "@/lib/google/transport";
import { listLineConnections } from "@/lib/notifications/db/lineConnections";
import { startCronRun, finishCronRun } from "@/lib/notifications/db/cronRuns";
import {
  closeStopInterval,
  getLegacyState,
  getReservationOperations,
  listPollableSalons,
  openStopInterval,
  pauseReservationNotifications,
  type PollableSalon,
} from "@/lib/notifications/db/operations";
import { dbScanStore } from "@/lib/notifications/db/gmailScanState";
import { resolveFetchStart } from "@/lib/notifications/mail/fetchStart";
import { GmailProvider } from "@/lib/notifications/mail/GmailProvider";
import type { MailProvider } from "@/lib/notifications/mail/MailProvider";
import { pushText, type LineSendOptions, type LineSendResult } from "@/lib/notifications/line/LineClient";
import { pollMailForSalon, type PollDependencies, type PollResult } from "@/lib/notifications/jobs/pollMailForSalon";
import type { DeliveryStore } from "@/lib/notifications/db/notificationDeliveries";
import { withDbTimeLimit } from "@/lib/notifications/dbTimeLimit";
import {
  createDeadline,
  CRON_RUN_BUDGET_MS,
  MIN_SALON_SLICE_MS,
  TOKEN_BUDGET_MS,
  type Deadline,
} from "@/lib/notifications/jobs/runBudget";

// 定期処理の入口。稼働中の店舗だけを、締切(CRON_RUN_BUDGET_MS)までに処理する。
//   - 店舗は「最後に処理を始めた日時」の古い順。残り時間を残りの店舗数で分け、1店舗が全体を使い切らない。
//     時間が足りない店舗は失敗にせず次の回へ回す(次の回の先頭になる)。時間が余れば、読み残しのある店舗をもう一度処理する
//   - アクセストークンは保存済みの refresh token から自動で取得する(同意画面は出さない)
//   - 認可そのものの失効(トークンの更新で invalid_grant)は、アカウントごとに1回の処理で1回だけ数える。連続したときだけ
//     「再接続が必要」にし、一時的な通信障害では再接続を求めない
//   - 予約メール(Gmail)の権限だけが足りない場合は、その店舗の予約メールの結び付けに記録する。アカウント全体の
//     認証の失敗としては数えない(同じアカウントの口コミ(GBP)を「再接続が必要」・停止扱いにしない)
//   - 旧サービス(hmail)利用店舗は、旧側が止まっていること・スタッフの集合が変わっていないことを毎回確かめ、
//     確認できなければ止める

export interface CronDependencies {
  transport: GoogleOAuthTransport;
  config: GoogleOAuthConfig;
  sendLine?: (destinationId: string, text: string, retryKey: string, options?: LineSendOptions) => Promise<LineSendResult>;
  /** テスト用: アクセストークンからメールの取得手段を作る(context はテストで店舗ごとの受信箱を分けるため)。 */
  createProvider?: (accessToken: string, context: { salonId: string; accountId: string }) => MailProvider;
  now?: () => Date;
  /** テスト用: 締切(省略時は CRON_RUN_BUDGET_MS)。 */
  deadline?: Deadline;
  /** テスト用: 配信の DB 操作・履歴の記録(遅延・失敗の再現)。 */
  deliveryStore?: DeliveryStore;
  recordHistory?: PollDependencies["recordHistory"];
}

export interface CronSummary {
  salonsProcessed: number;
  salonsFailed: number;
  salonsSkipped: number;
  /** 時間が足りず、次の回へ回した店舗(失敗ではない)。 */
  salonsDeferred: number;
  results: Array<{ salonId: string; result: PollResult | null; skippedReason?: string }>;
}

type TokenOutcome =
  | { kind: "ok"; accessToken: string; scopes: string[] | null }
  | { kind: "auth_failed" }
  | { kind: "unavailable" };

function appLink(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  return appUrl ? `${new URL(appUrl).origin}/dashboard/settings/google` : "SalonPackのGoogle連携の画面";
}

async function alertOwners(salonId: string, text: string, sendLine: NonNullable<CronDependencies["sendLine"]>): Promise<void> {
  const ops = await getReservationOperations(salonId);
  if (ops?.state !== "active") return; // 稼働中の店舗だけに知らせる(切り替え待ちの店舗は旧側が通知中)。
  const recipients = (await listLineConnections(salonId)).filter((r) => r.status === "connected" && r.destinationId);
  await Promise.allSettled(recipients.map((r) => sendLine(r.destinationId!, text, crypto.randomUUID())));
}

async function onAuthResult(accountId: string, result: AuthResult, sendLine: NonNullable<CronDependencies["sendLine"]>) {
  if (result !== "became_needs_reauth" && result !== "recovered") return;
  const bound = await listSalonsBoundToAccount(accountId);
  for (const binding of bound) {
    if (result === "became_needs_reauth") {
      if (binding.feature === "gmail") await openStopInterval(binding.salonId, "auth", "system:google_auth", "invalid_grant");
      await recordConnectionEvent({ salonId: binding.salonId, feature: binding.feature, googleAccountId: accountId, accountEmail: null, event: "needs_reauth" });
      if (binding.feature === "gmail") {
        await alertOwners(
          binding.salonId,
          `予約メールとのGoogle連携が切れました。予約通知は止まっています。\n\nお手数ですが、${appLink()} から再接続をお願いします。`,
          sendLine
        );
      }
    } else {
      if (binding.feature === "gmail") await closeStopInterval(binding.salonId, "auth", "system:google_auth");
      await recordConnectionEvent({ salonId: binding.salonId, feature: binding.feature, googleAccountId: accountId, accountEmail: null, event: "reauthed" });
    }
  }
}

/** 予約メール(Gmail)の権限だけが足りない: その店舗の結び付けに記録する(アカウントの認証状態は変えない)。 */
async function onGmailScopeMissing(salon: PollableSalon, scopes: string[] | null, sendLine: NonNullable<CronDependencies["sendLine"]>) {
  const marked = await markBindingScope({ salonId: salon.salonId, feature: "gmail", missing: true, grantedScopes: scopes });
  if (marked !== "became_missing") return;
  await openStopInterval(salon.salonId, "gmail_scope", "system:gmail_scope", "insufficient_scope");
  await alertOwners(
    salon.salonId,
    `予約メールを読むためのGoogleの権限(Gmailの読み取り)が足りないため、予約通知が止まっています。\n\nお手数ですが、${appLink()} の「権限を追加する」から許可をお願いします。`,
    sendLine
  );
}

async function onGmailReadable(salon: PollableSalon) {
  if (salon.gmailScopeMissingSince) {
    await markBindingScope({ salonId: salon.salonId, feature: "gmail", missing: false, grantedScopes: null });
  }
  if (salon.openAutoStops.includes("gmail_scope")) await closeStopInterval(salon.salonId, "gmail_scope", "system:gmail_scope");
}

export async function pollMailForAllSalons(deps: CronDependencies): Promise<CronSummary> {
  const deadline = deps.deadline ?? createDeadline(CRON_RUN_BUDGET_MS);
  // この回の DB への問い合わせは、すべて上限(強制終了)の手前で打ち切る。送信前の問い合わせは
  // pollMailForSalon がさらに短くする(LINE への送信と記録の時間を残す)。
  return withDbTimeLimit(() => deadline.hardRemainingMs() - 1_000, () => runAllSalons(deps, deadline));
}

async function runAllSalons(deps: CronDependencies, deadline: Deadline): Promise<CronSummary> {
  const sendLine = deps.sendLine ?? pushText;
  const createProvider = deps.createProvider ?? ((token: string) => new GmailProvider(token));
  const allowedPlans = isFeatureServedByMode("notifications") ? plansIncluding("notifications") : [];
  const summary: CronSummary = { salonsProcessed: 0, salonsFailed: 0, salonsSkipped: 0, salonsDeferred: 0, results: [] };
  const salons = allowedPlans.length > 0 ? await listPollableSalons(allowedPlans) : [];

  const runId = await startCronRun();
  const tokens = new Map<string, TokenOutcome>();
  const processed = new Set<string>();
  let quotaExceeded = false;

  /** アカウントごとに1回だけアクセストークンを取得し、認証の成否を記録する。 */
  async function tokenFor(accountId: string): Promise<TokenOutcome> {
    const cached = tokens.get(accountId);
    if (cached) return cached;
    let outcome: TokenOutcome;
    const account = await getGoogleAccount(accountId);
    if (!account || account.authState !== "active") {
      outcome = { kind: "unavailable" };
    } else {
      try {
        const token = await obtainGoogleAccessToken(account, deps);
        outcome = { kind: "ok", accessToken: token.accessToken, scopes: token.scopes };
        // トークンの更新に成功した = 認可そのものは有効(Gmail の権限が足りるかどうかとは別)。
        await onAuthResult(accountId, await recordGoogleAuthResult(accountId, true), sendLine);
      } catch (error) {
        logSafeError("notifications/cron token", error);
        if (classifyGoogleError(error) === "invalid_grant") {
          await onAuthResult(accountId, await recordGoogleAuthResult(accountId, false), sendLine);
          outcome = { kind: "auth_failed" };
        } else {
          outcome = { kind: "unavailable" };
        }
      }
    }
    tokens.set(accountId, outcome);
    return outcome;
  }

  async function processSalon(salon: PollableSalon, slice: Deadline): Promise<PollResult | null> {
    if (quotaExceeded) {
      summary.salonsSkipped++;
      return null;
    }
    if (!tokens.has(salon.googleAccountId) && !slice.allows(TOKEN_BUDGET_MS)) {
      summary.salonsDeferred++;
      return null;
    }
    const token = await tokenFor(salon.googleAccountId);
    if (token.kind !== "ok") {
      summary.salonsSkipped++;
      summary.results.push({ salonId: salon.salonId, result: null, skippedReason: `token_${token.kind}` });
      return null;
    }
    if (salon.openAutoStops.includes("auth")) {
      // 再接続(コールバック)で認可が戻ったあと、最初に読めた回に「認証切れ」の期間を閉じる。
      await closeStopInterval(salon.salonId, "auth", "system:google_auth");
    }

    if (salon.legacySource) {
      const legacy = await getLegacyState(salon.salonId);
      if (legacy !== "stopped") {
        await pauseReservationNotifications({
          salonId: salon.salonId,
          by: "system:legacy_watchdog",
          reason: `legacy_${legacy}`,
          kind: "legacy_active",
        });
        summary.results.push({ salonId: salon.salonId, result: null, skippedReason: `legacy_${legacy}` });
        summary.salonsSkipped++;
        return null;
      }
    }

    // トークンの更新の応答で Gmail の権限が無いと分かっている場合は Gmail を読まない(作成済みの配信は送る)。
    const gmailScopeKnownMissing = token.scopes !== null && !hasScopeFor(token.scopes, "gmail");
    if (gmailScopeKnownMissing) await onGmailScopeMissing(salon, token.scopes, sendLine);

    const fetchStart = resolveFetchStart({
      mailFetchSince: salon.mailFetchSince,
      mailFetchAccountId: salon.mailFetchAccountId,
      currentAccountId: salon.googleAccountId,
      accountBoundAt: salon.accountBoundAt,
    });
    const result = await pollMailForSalon(
      {
        salonId: salon.salonId,
        accountId: salon.googleAccountId,
        initialWatermark: fetchStart.since,
        recipients: await listLineConnections(salon.salonId),
        readMail: !gmailScopeKnownMissing,
      },
      {
        provider: createProvider(token.accessToken, { salonId: salon.salonId, accountId: salon.googleAccountId }),
        scanStore: dbScanStore,
        sendLine,
        allowedPlans,
        now: deps.now,
        deadline: slice,
        deliveryStore: deps.deliveryStore,
        recordHistory: deps.recordHistory,
      }
    );
    summary.results.push({ salonId: salon.salonId, result });
    if (!processed.has(salon.salonId)) {
      processed.add(salon.salonId);
      summary.salonsProcessed++;
    }
    if (result.quotaExceeded) quotaExceeded = true;
    if (result.scopeMissing) await onGmailScopeMissing(salon, token.scopes, sendLine);
    else if (result.scanned) await onGmailReadable(salon);
    if (result.authFailure === "invalid_grant") {
      // Gmail の API が認可そのものの失効を返した(まれ)。アカウント単位で1回の処理につき1回だけ数える。
      tokens.set(salon.googleAccountId, { kind: "auth_failed" });
      await onAuthResult(salon.googleAccountId, await recordGoogleAuthResult(salon.googleAccountId, false), sendLine);
    }
    return result;
  }

  async function safely(salon: PollableSalon, slice: Deadline): Promise<PollResult | null> {
    try {
      return await processSalon(salon, slice);
    } catch (error) {
      summary.salonsFailed++;
      logSafeError("notifications/cron salon", error);
      return null;
    }
  }

  // 1巡目: 古い順に、残り時間を残りの店舗数で分ける。
  const again: PollableSalon[] = [];
  for (let i = 0; i < salons.length; i++) {
    if (!deadline.allows(MIN_SALON_SLICE_MS)) {
      summary.salonsDeferred += salons.length - i;
      break;
    }
    const left = salons.length - i;
    const slice = deadline.child(Math.max(MIN_SALON_SLICE_MS, deadline.remainingMs() / left));
    const result = await safely(salons[i], slice);
    if (result?.moreWork) again.push(salons[i]);
  }
  // 2巡目: 時間が余っていれば、読み残し・送り残しのある店舗をもう一度。
  for (let i = 0; i < again.length; i++) {
    if (!deadline.allows(MIN_SALON_SLICE_MS)) break;
    const slice = deadline.child(Math.max(MIN_SALON_SLICE_MS, deadline.remainingMs() / (again.length - i)));
    await safely(again[i], slice);
  }

  const notes = [
    quotaExceeded ? "line_monthly_quota_exceeded" : null,
    summary.salonsDeferred > 0 ? `deferred_for_time:${summary.salonsDeferred}` : null,
  ].filter(Boolean);
  await finishCronRun(runId, {
    salonsProcessed: summary.salonsProcessed,
    salonsFailed: summary.salonsFailed,
    notes: notes.length > 0 ? notes.join(",") : undefined,
  });
  return summary;
}
