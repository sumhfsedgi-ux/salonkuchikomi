import {
  FORBIDDEN_KINDS,
  GBP_API_TIMEOUT_MS,
  isGbpApiError,
  type GbpApiClient,
  type GbpApiErrorKind,
  type GoogleLocation,
  type GoogleReviewJson,
  type GoogleReviewPage,
  type GoogleReviewReplyJson,
} from "@/lib/gbp/apiClient";
import { GbpTokenError, type GbpAccess, type GbpBinding } from "@/lib/gbp/access";
import { toCachedReview, toReviewDetail, toReviewSummary } from "@/lib/gbp/mapping";
import { normalizeReplyText, replyHash, sha256Hex } from "@/lib/gbp/replyText";
import {
  GBP_CONTENT_TTL_SECONDS,
  GBP_FULL_RESCAN_AFTER_SECONDS,
  GbpLocationInactiveError,
  GbpSyncLeaseLostError,
  type CompleteReplyStatus,
  type GbpStore,
  type InboxSummaryRow,
  type StartSendOutcome,
} from "@/lib/gbp/store";
import { REPLY_MAX_BYTES, utf8Bytes } from "@/lib/replyGeneration/text";
import type {
  ActionResult,
  GbpAccountOption,
  GbpConnectionState,
  GoogleReply,
  InboxSummary,
  ReplySubmitRequest,
  ReplySubmitResult,
  ReviewDetail,
  ReviewDetailResult,
  ReviewListQuery,
  ReviewListResult,
  StarRatingValue,
} from "@/lib/googleReviews/types";

// 届いた口コミのサーバー処理(計画 第2版 §2・§3)。Google の API・DB・共通の Google 連携は差し替えられる(deps)。
//   連携    : 共通の Google 連携の口コミの結び付けを使う(口コミ専用の OAuth・トークンは持たない)。
//   同意    : 連携の同意(口コミの一時保存・AI での処理・投稿はボタンを押したときだけ、など)を今の版で記録している
//             店舗だけ、口コミの API を呼ぶ・保存する・AI の入力を渡す・投稿する。記録が無ければ、店舗の候補も取らない
//             (共通の Google 連携の画面から連携した場合も同じ。同意の版を上げたら、記録し直すまで止まる)。
//   店舗選択: 一覧はその場で Google から取る(保存しない)。選んだロケーションだけ保存し、初回の取り込みを行う。
//   同期    : 口コミを索引(HMAC のキー)と一時保存(25日)に入れる。1回の同期(run)は時間・ページ数で区切り、
//             途中経過を DB に残して次回に続きから読む。最後まで読み終えたときだけ watermark を進める。
//             書き込みは、同期の処理権を持ち、選択の世代が使えるときだけ(DB が確かめる)。
//   返信    : 確認ダイアログで作った op_id ごとに1回。送る直前に Google から取り直し、画面で見ていた返信から変わっていたら
//             送らない(競合)。書き込みの直前に、DB で処理権・利用可否・世代を確かめ、アプリでも有効か(canWrite)を確かめる。
//             時間切れなどは「結果不明」にし、成功とも失敗とも言わない。取り直して確かめるまで、もう一度送らない。
//             API が受け付けたこと(accepted)と公開されたか(審査の状態)は分け、取り直して確かめるまで公開済みにしない。
// 予約メール(Gmail)の結び付け・アカウントの認証の状態は変えない(lib/gbp/access.ts)。トークン・口コミの中身はログに出さない。

export interface SourceContext {
  salonId: string;
  userId: string;
}

export interface GbpInboxDeps {
  store: GbpStore;
  api: GbpApiClient;
  access: GbpAccess;
  /** REVIEW_KEY_HMAC_SECRET。 */
  reviewKeySecret: string;
  /** 書き込みの直前に確かめる、このデプロイで Google への書き込みを許すか(GOOGLE_REVIEWS_OAUTH_ENABLED)。 */
  canWrite: () => boolean;
  now?: () => number;
  pageSize?: number;
  maxSyncPages?: number;
  syncBudgetMs?: number;
  syncPageReserveMs?: number;
  minRefreshIntervalMs?: number;
  consentVersion?: string;
}

export interface ReplyInput {
  text: string;
  rating: StarRatingValue | null;
  /** 選択の世代。生成のあと、まだ同じ世代かを確かめる。 */
  locationId: string;
}

export interface GbpInbox {
  getConnection(ctx: SourceContext): Promise<GbpConnectionState>;
  recordConsent(ctx: SourceContext): Promise<ActionResult>;
  hasConsent(ctx: SourceContext): Promise<boolean>;
  selectLocation(ctx: SourceContext, locationName: string): Promise<ActionResult>;
  /** 店舗の選び直しを始める(今の店舗の一時保存・下書きは消える。Google には何も送らない)。 */
  beginLocationChange(ctx: SourceContext): Promise<ActionResult>;
  listReviews(ctx: SourceContext, query: ReviewListQuery, cursor: string | null): Promise<ReviewListResult>;
  getReview(ctx: SourceContext, id: string): Promise<ReviewDetailResult>;
  /** 「更新」。最短の間隔(5分)より短ければ Google に問い合わせない。途中で区切った取り込みの続きは、間隔に関係なく読む。 */
  refresh(ctx: SourceContext): Promise<ActionResult<{ lastCheckedAt: string; syncIncomplete: boolean }>>;
  /** 1件の口コミの最新の状態を取り直す(「Googleで確認する」)。 */
  checkReview(ctx: SourceContext, id: string): Promise<ActionResult<ReviewDetail>>;
  setSeen(ctx: SourceContext, id: string, seen: boolean): Promise<ActionResult>;
  saveDraft(ctx: SourceContext, id: string, text: string): Promise<ActionResult<{ savedAt: string }>>;
  /** 口コミの本文と★(AI の返信案の入力。サーバーの中だけで使う。投稿者名は含めない)。 */
  getReplyInput(ctx: SourceContext, id: string): Promise<ActionResult<ReplyInput>>;
  /** その口コミが、まだ同じ世代で使えるか(生成のあとの確認)。 */
  isCurrent(ctx: SourceContext, id: string, locationId: string): Promise<boolean>;
  submitReply(ctx: SourceContext, request: ReplySubmitRequest): Promise<ReplySubmitResult>;
  /**
   * 送れなかったと分かっている返信の操作(failed)を、表示しないようにする(「送るのをやめる」)。Google には何も送らない。
   * 結果不明・送信中・反映を確かめていない操作は変えない(「Googleで確認する」で確かめるまで、そのまま)。
   */
  dismissReplyOperation(ctx: SourceContext, id: string): Promise<ActionResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WATERMARK_OVERLAP_SECONDS = 60 * 60;
const SYNC_LEASE_SECONDS = 60;
const SYNC_RETRY_HOLD_SECONDS = 30;
const MAX_SKIP_PAGES = 100;
export const GBP_MIN_REFRESH_INTERVAL_MS = 5 * 60_000;
/** 返信の操作の処理権:始めてから、送る直前の取り直し(時間切れ10秒)と記録まで。 */
const REPLY_LEASE_SECONDS = 60;
/** 書き込みの直前に延ばす処理権:書き込みの時間切れ + 記録の余裕。 */
const REPLY_WRITE_WINDOW_SECONDS = Math.ceil(GBP_API_TIMEOUT_MS / 1000) + 20;
/** Google の返信の編集の上限(1つのビジネスにつき1分に10回)。 */
const REPLY_EDITS_PER_MINUTE = 10;
export const GBP_CONSENT_VERSION = "gbp-connect-2026-10-15";

const NOT_CONNECTED = "Google口コミを連携していません。";
const FETCH_FAILED = "最新の口コミを取得できませんでした。少し時間をおいて、もう一度お試しください。";
const SYNC_BUSY = "Googleから口コミを取得している途中です。少し時間をおいて、もう一度お試しください。";
const REFETCHING = "Googleから口コミを取り直しています。少し時間をおいて、もう一度お試しください。";
const REFETCH_FAILED = "Googleから口コミを取り直せませんでした。少し時間をおいて、もう一度お試しください。";
const STALE = "Google連携または店舗が変わったため、この口コミは表示できません。一覧を読み込み直してください。";
const DELETED = "この口コミはGoogle上で削除されました。";
const RECONNECT = "Googleとの連携の確認が必要です。Google連携の画面から再連携してください。";
const SCOPE_MISSING = "口コミの権限が足りません。Google連携の画面で、口コミの権限を追加してください。";
const PERMISSION = "この店舗を管理する権限を確認できません。Googleビジネスプロフィールの管理者に確認してください。";
const SERVICE = "現在、Googleの口コミの機能を利用できません。時間をおいてもう一度お試しください。";
const PRECONDITION = "このビジネスはGoogleでオーナー確認が済んでいないため、口コミを扱えません。";
const REPLY_STOPPED = "確認に時間がかかったため、この操作を止めました。返信は送っていません。最新の状態を確認してから、もう一度お試しください。";
const REPLY_SUPERSEDED =
  "Googleには送りましたが、結果を記録する前に処理の時間が切れました。反映されたか分からないため、「Googleで確認する」で確かめてください。確認できるまで、もう一度送らないでください。";
const REPLY_UNKNOWN =
  "Googleからの応答を確認できませんでした。返信が反映されているかもしれません。「Googleで確認する」で確かめてください。確認できるまで、もう一度送らないでください。";
const LOCATION_CHANGED = "Google連携または店舗が変わったため、返信は送っていません。一覧を読み込み直してください。";
const NOT_ENTITLED = "Google口コミを利用できなくなったため、返信は送っていません。";
const CONSENT_REQUIRED = "口コミの取り扱いについての確認がまだ済んでいません。「口コミ」タブで内容を確認してください。";
const REPLY_UNRESOLVED =
  "前に送った返信の反映を、まだ確認できていません。後からGoogleに反映されることがあるため、確認できるまでは新しく送れません。今回の返信は送っていません。「Googleで確認する」で確かめてください。";

type SyncOutcome = { kind: "complete" | "partial"; at: string | null } | { kind: "throttled"; at: string | null } | { kind: "busy" } | { kind: "inactive" };

/** Google の呼び出しの失敗(この処理の中の分類)。 */
type CallFailure = "needs_reconnect" | "scope_missing" | "permission" | "service" | "not_found" | "invalid_argument" | "precondition" | "rate_limited" | "unavailable";

class GoogleCallError extends Error {
  constructor(
    readonly kind: CallFailure,
    /** 元の API のエラーの種類(token はトークンの取得の失敗)。 */
    readonly apiKind?: GbpApiErrorKind | "token",
  ) {
    super(`gbp inbox: ${kind}`);
  }
}

function callMessage(err: unknown, fallback: string): string {
  if (!(err instanceof GoogleCallError)) return fallback;
  switch (err.kind) {
    case "needs_reconnect":
      return RECONNECT;
    case "scope_missing":
      return SCOPE_MISSING;
    case "permission":
      return PERMISSION;
    case "service":
      return SERVICE;
    case "precondition":
      return PRECONDITION;
    case "rate_limited":
      return "Googleへの問い合わせが混み合っています。少し時間をおいて、もう一度お試しください。";
    default:
      return fallback;
  }
}

/** 書き込み(返信の投稿・削除)の失敗を、反映されていない(failed)か、分からない(unknown)かに分ける。 */
function writeFailure(err: unknown): { status: "unknown" | "failed"; code: string; deleted?: boolean; result: ReplySubmitResult } {
  const failed = (code: string, message: string, retryable: boolean) => ({ status: "failed" as const, code, result: { kind: "failed" as const, message, retryable } });
  if (err instanceof GoogleCallError) {
    if (err.kind === "needs_reconnect") return failed("needs_reconnect", `${RECONNECT}返信は送っていません。`, false);
    if (err.kind === "scope_missing") return failed("scope_missing", `${SCOPE_MISSING}返信は送っていません。`, false);
    if (err.kind === "permission") return failed("permission_denied", "この店舗の返信を管理する権限が確認できません。返信は送っていません。Googleビジネスプロフィールの管理者に確認してください。", false);
    if (err.kind === "service") return failed("service_disabled", `${SERVICE}返信は送っていません。`, true);
    if (err.kind === "not_found") return { status: "failed", code: "deleted_on_google", deleted: true, result: { kind: "deleted_on_google", message: DELETED } };
    if (err.kind === "invalid_argument" || err.apiKind === "bad_response") return failed("rejected", "Googleが返信を受け付けませんでした。文章を見直してください。", false);
    if (err.kind === "precondition") return failed("failed_precondition", "このビジネスはGoogleでオーナー確認が済んでいないため、返信できません。", false);
    if (err.kind === "rate_limited") return failed("rate_limited", "Googleで短い時間に続けて返信を送れません。返信は送っていません。少し時間をおいて、もう一度お試しください。", true);
    if (err.apiKind === "token") return failed("token", "Googleに接続できませんでした。返信は送っていません。少し時間をおいて、もう一度お試しください。", true);
  }
  // 時間切れ・通信の切断・5xx・想定外:Google が受け取ったかどうか分からない。
  return { status: "unknown", code: "unknown_outcome", result: { kind: "unknown", message: REPLY_UNKNOWN } };
}

function toInboxSummary(row: InboxSummaryRow): InboxSummary {
  return {
    locationId: row.locationId,
    location: { title: row.title, address: null },
    averageRating: row.averageRating,
    totalReviewCount: row.totalReviewCount,
    ratingAt: row.ratingCachedAt,
    lastCheckedAt: row.lastSyncedAt,
    initialSyncDone: row.initialSyncDone,
    syncIncomplete: row.syncInProgress,
    contentExpired: row.hasExpired,
    newCount: row.newCount,
  };
}

export function createGbpInbox(deps: GbpInboxDeps): GbpInbox {
  const { store, api, access } = deps;
  const now = deps.now ?? Date.now;
  const pageSize = deps.pageSize ?? 20;
  const maxSyncPages = deps.maxSyncPages ?? 5;
  const syncBudgetMs = deps.syncBudgetMs ?? 20_000;
  const syncPageReserveMs = deps.syncPageReserveMs ?? 10_000;
  const minRefreshIntervalMs = deps.minRefreshIntervalMs ?? GBP_MIN_REFRESH_INTERVAL_MS;
  const consentVersion = deps.consentVersion ?? GBP_CONSENT_VERSION;
  const iso = (ms: number) => new Date(ms).toISOString();

  /** 今の版の連携の同意を記録している店舗か(確かめられなければ、記録していない扱い)。 */
  async function consented(salonId: string): Promise<boolean> {
    try {
      return await store.hasConnectConsent(salonId, consentVersion);
    } catch {
      return false;
    }
  }

  async function tokenFor(salonId: string, binding: GbpBinding, fresh = false): Promise<string> {
    try {
      return await access.accessToken(binding, { fresh });
    } catch (err) {
      if (err instanceof GbpTokenError) {
        if (err.kind === "invalid_grant") throw new GoogleCallError("needs_reconnect", "token");
        if (err.kind === "scope_missing") {
          await access.markScopeMissing(salonId, null);
          throw new GoogleCallError("scope_missing", "token");
        }
      }
      throw new GoogleCallError("unavailable", "token");
    }
  }

  /** API のエラーを、この処理の分類にする。口コミの権限不足と確かめられたときだけ、口コミの結び付けに記録する。 */
  async function callError(salonId: string, err: unknown): Promise<GoogleCallError> {
    if (err instanceof GoogleCallError) return err;
    if (!isGbpApiError(err)) return new GoogleCallError("unavailable");
    switch (err.kind) {
      case "unauthorized":
        return new GoogleCallError("needs_reconnect", err.kind);
      case "scope_insufficient":
        await access.markScopeMissing(salonId, null);
        return new GoogleCallError("scope_missing", err.kind);
      case "service_disabled":
        console.warn("gbp: the Business Profile API is not enabled for this project");
        return new GoogleCallError("service", err.kind);
      case "permission_denied":
      case "forbidden":
        return new GoogleCallError("permission", err.kind);
      case "not_found":
        return new GoogleCallError("not_found", err.kind);
      case "invalid_argument":
        return new GoogleCallError("invalid_argument", err.kind);
      case "failed_precondition":
        return new GoogleCallError("precondition", err.kind);
      case "rate_limited":
        return new GoogleCallError("rate_limited", err.kind);
      default:
        return new GoogleCallError("unavailable", err.kind);
    }
  }

  /** Google の API を呼ぶ(読み取り)。401 なら1回だけトークンを取り直す。 */
  async function withGoogle<T>(salonId: string, binding: GbpBinding, call: (token: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await tokenFor(salonId, binding, attempt > 0);
      try {
        return await call(token);
      } catch (err) {
        if (isGbpApiError(err) && err.kind === "unauthorized" && attempt === 0) continue;
        throw await callError(salonId, err);
      }
    }
    throw new GoogleCallError("needs_reconnect");
  }

  /**
   * Google への書き込み(返信の投稿・削除)。書き込みの直前の確認(check。DB の処理権・利用可否・世代と、アプリの canWrite)の
   * すぐあとに、ほかの待ちを挟まずに書き込む。アクセストークンの取得は確認より前に済ませる。
   * 401(反映されていない)なら、トークンを取り直し、確認をやり直してから1回だけ送り直す。
   */
  async function guardedWrite<T>(
    salonId: string,
    binding: GbpBinding,
    check: () => Promise<StartSendOutcome>,
    call: (token: string) => Promise<T>,
  ): Promise<{ sent: true; value: T } | { sent: false; outcome: Exclude<StartSendOutcome, "ok"> | "write_disabled" }> {
    let token = await tokenFor(salonId, binding);
    for (let attempt = 0; ; attempt++) {
      // このデプロイで書き込みを許すか(環境変数)を先に見る(止めたときに「送り始めた」記録を残さない)。
      if (!deps.canWrite()) return { sent: false, outcome: "write_disabled" };
      const outcome = await check();
      if (outcome !== "ok") return { sent: false, outcome };
      try {
        return { sent: true, value: await call(token) };
      } catch (err) {
        if (isGbpApiError(err) && err.kind === "unauthorized" && attempt === 0) {
          token = await tokenFor(salonId, binding, true);
          continue;
        }
        throw await callError(salonId, err);
      }
    }
  }

  /** 口コミの結び付けが、口コミの API を呼べる状態か。 */
  function usableBinding(binding: GbpBinding | null): binding is GbpBinding {
    return binding !== null && binding.authState === "active" && !binding.scopeMissing && binding.scopeGranted;
  }

  async function loadBusinesses(salonId: string, binding: GbpBinding) {
    const locations = new Map<string, { account: string; location: GoogleLocation }>();
    try {
      const accounts = await withGoogle(salonId, binding, (token) => api.listAccounts(token));
      const options: GbpAccountOption[] = [];
      for (const account of accounts) {
        let list: GoogleLocation[];
        try {
          list = await withGoogle(salonId, binding, (token) => api.listLocations(token, account.name));
        } catch (err) {
          if (err instanceof GoogleCallError && err.kind === "permission") continue; // そのアカウントは見られない
          throw err;
        }
        const items = [];
        for (const location of list) {
          locations.set(location.name, { account: account.name, location });
          const elsewhere = await store.isLocationLinkedElsewhere(location.name, salonId);
          items.push({
            locationName: location.name,
            title: location.title,
            address: location.address,
            unavailableReason: !location.hasVoiceOfMerchant ? ("unverified" as const) : elsewhere ? ("linked_elsewhere" as const) : null,
          });
        }
        if (items.length) options.push({ accountName: account.name, displayName: account.accountName ?? "Googleアカウント", locations: items });
      }
      return { accounts: options, locations };
    } catch (err) {
      return { accounts: [], locations, loadError: callMessage(err, "Googleからビジネスの一覧を取得できませんでした。少し時間をおいて、もう一度お試しください。") };
    }
  }

  async function refreshLocationInfo(salonId: string, binding: GbpBinding, location: InboxSummaryRow) {
    try {
      const list = await withGoogle(salonId, binding, (token) => api.listLocations(token, location.accountName));
      const found = list.find((l) => l.name === location.locationName);
      if (found) await store.updateLocationInfo(salonId, location.locationId, found.title, found.address);
    } catch {
      console.warn("gbp: could not refresh location info");
    }
  }

  /**
   * 同期を1回分進める(updateTime の新しい順に、時間・ページ数の上限まで)。
   *   ・途中で区切ったら、続きの位置を DB に残して処理権を返す(partial)。次の呼び出しは続きから読む
   *   ・最後のページ、または差分の同期で前回の範囲に届いたら、読み終えて watermark を進める(complete)
   *   ・失敗したら、途中経過は残したまま処理権を返す。続きの位置が受け付けられなければ先頭から読み直し、
   *     読み終えた範囲より新しいだけのページは書き込まずに進む
   *   ・連携・店舗が変わったら(世代が使えない)、書き込まずにやめる(inactive)
   */
  async function syncLocation(salonId: string, binding: GbpBinding, location: InboxSummaryRow, minIntervalMs: number): Promise<SyncOutcome> {
    const begun = await store.beginSync(salonId, location.locationId, {
      leaseSeconds: SYNC_LEASE_SECONDS,
      fullRescanAfterSeconds: GBP_FULL_RESCAN_AFTER_SECONDS,
      minIntervalSeconds: Math.ceil(minIntervalMs / 1000),
      overlapSeconds: WATERMARK_OVERLAP_SECONDS,
    });
    if (begun.status === "busy") return { kind: "busy" };
    if (begun.status === "inactive") return { kind: "inactive" };
    if (begun.status === "throttled") return { kind: "throttled", at: begun.lastSyncedAt };

    const { leaseToken } = begun;
    const deadline = now() + syncBudgetMs;
    const floor = begun.floor ? Date.parse(begun.floor) : null;
    let resumeBefore = begun.resumeBefore ? Date.parse(begun.resumeBefore) : null;
    let pageToken = begun.pageToken;
    let read = 0;
    let skipped = 0;
    let contacted = false;
    let restarted = false;
    const release = (failed: boolean) =>
      store.releaseSync(salonId, location.locationId, leaseToken, { contacted, failed, holdSeconds: failed ? SYNC_RETRY_HOLD_SECONDS : 0 });

    if (begun.status === "started" && begun.kind === "full" && location.initialSyncDone) await refreshLocationInfo(salonId, binding, location);

    try {
      for (;;) {
        if (read >= maxSyncPages || skipped >= MAX_SKIP_PAGES || (contacted && now() + syncPageReserveMs > deadline)) {
          return { kind: "partial", at: await release(false) };
        }
        let page: GoogleReviewPage;
        try {
          page = await withGoogle(salonId, binding, (token) => api.listReviews(token, location.accountName, location.locationName, pageToken));
        } catch (err) {
          if (pageToken !== null && !restarted && err instanceof GoogleCallError && err.kind === "invalid_argument") {
            pageToken = null; // 続きの位置が受け付けられない:先頭から読み直す(読み終えた範囲は読み飛ばす)
            restarted = true;
            continue;
          }
          throw err;
        }
        contacted = true;
        const times = page.reviews.map((r) => Date.parse(r.updateTime || r.createTime)).filter((t) => Number.isFinite(t));
        const oldest = times.length ? Math.min(...times) : null;
        const newest = times.length ? Math.max(...times) : null;
        const skip = resumeBefore !== null && oldest !== null && oldest > resumeBefore;
        if (skip) {
          skipped++;
        } else {
          const inputs = page.reviews.map((review) => toCachedReview(review, deps.reviewKeySecret));
          try {
            await store.ingestReviews(salonId, location.locationId, leaseToken, inputs, GBP_CONTENT_TTL_SECONDS);
          } catch (err) {
            if (err instanceof GbpLocationInactiveError) return { kind: "inactive" };
            if (err instanceof GbpSyncLeaseLostError) return { kind: "busy" };
            throw err;
          }
          read++;
          if (oldest !== null) resumeBefore = resumeBefore === null ? oldest : Math.min(resumeBefore, oldest);
        }
        const done = !page.nextPageToken || (floor !== null && oldest !== null && oldest < floor);
        if (done) {
          const at = await store.finishSync(salonId, location.locationId, leaseToken, {
            newest: skip || newest === null ? null : iso(newest),
            averageRating: page.averageRating,
            totalReviewCount: page.totalReviewCount,
          });
          return at ? { kind: "complete", at } : { kind: "busy" };
        }
        const kept = await store.checkpointSync(
          salonId,
          location.locationId,
          leaseToken,
          {
            pageToken: page.nextPageToken!,
            resumeBefore: skip || oldest === null ? null : iso(oldest),
            newest: skip || newest === null ? null : iso(newest),
            averageRating: page.averageRating,
            totalReviewCount: page.totalReviewCount,
          },
          SYNC_LEASE_SECONDS,
        );
        if (!kept) return { kind: "busy" };
        pageToken = page.nextPageToken;
      }
    } catch (err) {
      await release(true).catch(() => null);
      throw err;
    }
  }

  async function reviewDetailOf(salonId: string, id: string): Promise<ReviewDetail | null> {
    const stored = await store.getReview(salonId, id);
    return stored.kind === "ok" ? toReviewDetail(stored.review) : null;
  }

  function googleReplyOf(review: GoogleReviewJson): GoogleReply | null {
    const cached = toCachedReview(review, deps.reviewKeySecret);
    if (!cached.replyComment) return null;
    return { comment: cached.replyComment, updateTime: cached.replyUpdateTime ?? cached.updateTime, state: cached.replyState ?? "UNSPECIFIED", policyViolation: cached.policyViolation };
  }

  /** Google から取り直した直後の口コミ(review)でだけ呼ぶ。 */
  async function reconcileOperations(salonId: string, id: string, review: GoogleReviewJson) {
    const cached = toCachedReview(review, deps.reviewKeySecret);
    try {
      await store.reconcileReplyOperations(salonId, id, {
        replySha256: replyHash(cached.replyComment),
        replyState: cached.replyState,
        replyUpdateTime: cached.replyUpdateTime,
      });
    } catch {
      console.warn("gbp: could not reconcile reply operations");
    }
  }

  /** 口コミを扱える状態(結び付けが使える・店舗を選んだ)か。同意は呼び出し側が先に確かめる。 */
  async function connectedContext(salonId: string): Promise<{ binding: GbpBinding; location: InboxSummaryRow } | null> {
    const binding = await access.binding(salonId);
    if (!usableBinding(binding) || binding.selectionState !== "selected") return null;
    const location = await store.getInboxSummary(salonId);
    if (!location || location.googleAccountId !== binding.googleAccountId) return null;
    return { binding, location };
  }

  return {
    async getConnection(ctx): Promise<GbpConnectionState> {
      const binding = await access.binding(ctx.salonId);
      if (!binding) return { kind: "not_connected" };
      if (binding.authState !== "active") return { kind: "needs_reconnect", googleEmail: binding.email };
      if (binding.scopeMissing || !binding.scopeGranted) return { kind: "scope_missing", googleEmail: binding.email };
      // 同意の前は、店舗の候補(Google のビジネスの一覧)も取らない。
      if (!(await consented(ctx.salonId))) return { kind: "consent_required", googleEmail: binding.email };
      const location = binding.selectionState === "selected" ? await store.getInboxSummary(ctx.salonId) : null;
      if (!location || location.googleAccountId !== binding.googleAccountId) {
        const { accounts, loadError } = await loadBusinesses(ctx.salonId, binding);
        return loadError ? { kind: "selecting", googleEmail: binding.email, accounts, loadError } : { kind: "selecting", googleEmail: binding.email, accounts };
      }
      return { kind: "connected", googleEmail: binding.email, location: { title: location.title, address: null }, connectedAt: binding.accountBoundAt };
    },

    async recordConsent(ctx) {
      try {
        await store.recordConsent(ctx.salonId, ctx.userId, consentVersion);
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: "同意を記録できませんでした。もう一度お試しください。" };
      }
    },

    async hasConsent(ctx) {
      return consented(ctx.salonId);
    },

    async selectLocation(ctx, locationName) {
      if (!(await consented(ctx.salonId))) return { ok: false, error: CONSENT_REQUIRED };
      const binding = await access.binding(ctx.salonId);
      if (!usableBinding(binding)) return { ok: false, error: "Google連携を確認できません。Google連携の画面から、もう一度お試しください。" };
      const { locations, loadError } = await loadBusinesses(ctx.salonId, binding);
      if (loadError) return { ok: false, error: loadError };
      const found = locations.get(locationName);
      if (!found) return { ok: false, error: "選んだビジネスが見つかりません。" };
      if (!found.location.hasVoiceOfMerchant) return { ok: false, error: "このビジネスはGoogleでオーナー確認が済んでいないため選べません。" };
      const result = await store.selectLocation({
        salonId: ctx.salonId,
        googleAccountId: binding.googleAccountId,
        accountName: found.account,
        locationName,
        title: found.location.title,
        address: found.location.address,
        userId: ctx.userId,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.reason === "linked_elsewhere" ? "このビジネスはほかの店舗と連携済みのため選べません。" : "Google連携が変わりました。画面を読み込み直して、もう一度お試しください。",
        };
      }
      // 初回の取り込み。失敗しても選択は終わっている(一覧で「取得中」と「続きを取得する」)。
      const location = await store.getInboxSummary(ctx.salonId);
      if (location) {
        try {
          await syncLocation(ctx.salonId, { ...binding, selectionState: "selected" }, location, 0);
        } catch {
          console.warn("gbp: initial sync failed");
        }
      }
      return { ok: true, value: undefined };
    },

    async beginLocationChange(ctx) {
      const binding = await access.binding(ctx.salonId);
      if (!binding) return { ok: false, error: NOT_CONNECTED };
      try {
        return (await store.beginLocationChange(ctx.salonId, binding.googleAccountId))
          ? { ok: true, value: undefined }
          : { ok: false, error: "Google連携が変わりました。画面を読み込み直して、もう一度お試しください。" };
      } catch {
        return { ok: false, error: "店舗の変更を始められませんでした。もう一度お試しください。" };
      }
    },

    async listReviews(ctx, query, cursor): Promise<ReviewListResult> {
      try {
        if (!(await consented(ctx.salonId))) return { kind: "error", message: CONSENT_REQUIRED };
        const connected = await connectedContext(ctx.salonId);
        if (!connected) return { kind: "not_connected" };
        const { location } = connected;
        const offset = cursor && /^\d{1,6}$/.test(cursor) ? Number.parseInt(cursor, 10) : 0;
        const rows = await store.listReviews(ctx.salonId, { ...query, offset, limit: pageSize });
        let noReviewsAtAll = false;
        if (rows.length === 0 && offset === 0) {
          noReviewsAtAll = (await store.listReviews(ctx.salonId, { filter: "all", rating: "all", sort: "newest", offset: 0, limit: 1 })).length === 0;
        }
        const summary = toInboxSummary(location);
        if (!location.initialSyncDone && noReviewsAtAll && !location.hasExpired) return { kind: "initial_sync", summary };
        return {
          kind: "ok",
          items: rows.slice(0, pageSize).map(toReviewSummary),
          nextCursor: rows.length > pageSize ? String(offset + pageSize) : null,
          summary,
          noReviewsAtAll: noReviewsAtAll && !location.hasExpired,
        };
      } catch {
        return { kind: "error", message: "口コミを読み込めませんでした。" };
      }
    },

    async getReview(ctx, id): Promise<ReviewDetailResult> {
      if (!UUID.test(id) || !(await consented(ctx.salonId))) return { kind: "not_found" };
      const stored = await store.getReview(ctx.salonId, id);
      if (stored.kind === "not_found" || stored.kind === "stale") return { kind: "not_found" };
      if (stored.kind === "deleted") return { kind: "deleted_on_google", draft: stored.draft };
      if (stored.kind === "expired") return { kind: "unavailable_content" };
      return { kind: "ok", review: toReviewDetail(stored.review) };
    },

    async refresh(ctx) {
      if (!(await consented(ctx.salonId))) return { ok: false, error: CONSENT_REQUIRED };
      const connected = await connectedContext(ctx.salonId);
      if (!connected) return { ok: false, error: NOT_CONNECTED };
      try {
        const outcome = await syncLocation(ctx.salonId, connected.binding, connected.location, minRefreshIntervalMs);
        if (outcome.kind === "busy") return { ok: false, error: SYNC_BUSY };
        if (outcome.kind === "inactive") return { ok: false, error: STALE };
        const after = await store.getInboxSummary(ctx.salonId);
        const at = outcome.at ?? connected.location.lastSyncedAt;
        return at ? { ok: true, value: { lastCheckedAt: at, syncIncomplete: after?.syncInProgress ?? false } } : { ok: false, error: FETCH_FAILED };
      } catch (err) {
        return { ok: false, error: callMessage(err, FETCH_FAILED) };
      }
    },

    async checkReview(ctx, id) {
      const failed = { ok: false as const, error: "最新の状態を取得できませんでした。少し時間をおいて、もう一度お試しください。" };
      if (!UUID.test(id)) return failed;
      if (!(await consented(ctx.salonId))) return { ok: false, error: CONSENT_REQUIRED };
      const connected = await connectedContext(ctx.salonId);
      if (!connected) return { ok: false, error: NOT_CONNECTED };
      const stored = await store.getReview(ctx.salonId, id);
      if (stored.kind === "stale" || stored.kind === "not_found") return { ok: false, error: STALE };
      if (stored.kind === "deleted") return { ok: false, error: DELETED };
      if (stored.kind === "expired") {
        // 名前は一時保存と一緒に消えているので、一覧を読み直して同じキーの口コミを取り直す(続きは次回)。
        let outcome: SyncOutcome;
        try {
          outcome = await syncLocation(ctx.salonId, connected.binding, connected.location, minRefreshIntervalMs);
        } catch (err) {
          return { ok: false, error: callMessage(err, REFETCH_FAILED) };
        }
        const after = await store.getReview(ctx.salonId, id);
        if (after.kind === "ok") return { ok: true, value: toReviewDetail(after.review) };
        if (after.kind === "deleted") return { ok: false, error: DELETED };
        return { ok: false, error: outcome.kind === "inactive" ? STALE : REFETCHING };
      }
      try {
        const review = await withGoogle(ctx.salonId, connected.binding, (token) => api.getReview(token, stored.review.reviewName));
        await store.ingestReviews(ctx.salonId, stored.review.locationId, null, [toCachedReview(review, deps.reviewKeySecret)], GBP_CONTENT_TTL_SECONDS);
        await reconcileOperations(ctx.salonId, id, review);
      } catch (err) {
        if (err instanceof GoogleCallError && err.kind === "not_found") {
          await store.markReviewDeleted(ctx.salonId, id);
          return { ok: false, error: DELETED };
        }
        if (err instanceof GbpLocationInactiveError) return { ok: false, error: STALE };
        return { ok: false, error: callMessage(err, failed.error) };
      }
      const updated = await store.getReview(ctx.salonId, id);
      return updated.kind === "ok" ? { ok: true, value: toReviewDetail(updated.review) } : failed;
    },

    async setSeen(ctx, id, seen) {
      if (!UUID.test(id)) return { ok: false, error: "口コミが見つかりません。" };
      if (!(await consented(ctx.salonId))) return { ok: false, error: CONSENT_REQUIRED };
      return (await store.setSeen(ctx.salonId, id, seen)) ? { ok: true, value: undefined } : { ok: false, error: "口コミが見つかりません。" };
    },

    async saveDraft(ctx, id, text) {
      const failed = { ok: false as const, error: "下書きを保存できませんでした。" };
      if (!UUID.test(id) || [...text].length > 5000) return failed;
      if (!(await consented(ctx.salonId))) return { ok: false, error: CONSENT_REQUIRED };
      try {
        const savedAt = await store.saveDraft(ctx.salonId, id, text, GBP_CONTENT_TTL_SECONDS);
        return savedAt ? { ok: true, value: { savedAt } } : { ok: false, error: STALE };
      } catch {
        return failed;
      }
    },

    async getReplyInput(ctx, id) {
      const failed = { ok: false as const, error: "この口コミの内容を読み込めませんでした。" };
      if (!UUID.test(id)) return failed;
      // 同意の前は、口コミの本文を AI の入力として渡さない。
      if (!(await consented(ctx.salonId))) return { ok: false, error: CONSENT_REQUIRED };
      const stored = await store.getReview(ctx.salonId, id);
      if (stored.kind === "expired") return { ok: false, error: "一時保存の期限が過ぎています。「Googleで確認する」で取り直してからお試しください。" };
      if (stored.kind === "stale") return { ok: false, error: STALE };
      if (stored.kind !== "ok") return failed;
      const stars = stored.review.starRating;
      return {
        ok: true,
        value: {
          text: stored.review.comment,
          rating: stars !== null && stars >= 1 && stars <= 5 ? (stars as StarRatingValue) : null,
          locationId: stored.review.locationId,
        },
      };
    },

    async isCurrent(ctx, id, locationId) {
      if (!UUID.test(id) || !(await consented(ctx.salonId))) return false;
      const stored = await store.getReview(ctx.salonId, id);
      return stored.kind === "ok" && stored.review.locationId === locationId;
    },

    async submitReply(ctx, request): Promise<ReplySubmitResult> {
      const badRequest: ReplySubmitResult = { kind: "failed", message: "送る内容を確認できませんでした。画面を読み込み直してください。", retryable: false };
      const action = request?.action;
      if (!request || !UUID.test(String(request.reviewId)) || !UUID.test(String(request.opId)) || (action !== "upsert" && action !== "delete")) {
        return badRequest;
      }
      const text = action === "upsert" ? normalizeReplyText(typeof request.text === "string" ? request.text : "") : null;
      if (action === "upsert" && (!text || utf8Bytes(text) > REPLY_MAX_BYTES)) {
        return { kind: "failed", message: "返信の文章を確認してください(空にはできず、Googleの上限の長さまでです)。", retryable: false };
      }
      const expected = request.expectedReply;
      if (expected !== null && (typeof expected !== "string" || utf8Bytes(expected) > REPLY_MAX_BYTES * 2)) return badRequest;
      if (!deps.canWrite()) return { kind: "unavailable", message: "Googleへの返信は準備中です。" };

      const connected = await connectedContext(ctx.salonId);
      if (!connected) {
        const binding = await access.binding(ctx.salonId);
        if (binding && binding.authState !== "active") return { kind: "unavailable", message: RECONNECT };
        if (binding && (binding.scopeMissing || !binding.scopeGranted)) return { kind: "unavailable", message: SCOPE_MISSING };
        return { kind: "unavailable", message: NOT_CONNECTED };
      }
      const { binding } = connected;
      // 連携のときの同意(返信は「Googleに返信する」を押したときだけ、その内容で投稿する)を記録していること。
      if (!(await consented(ctx.salonId))) return { kind: "unavailable", message: `${CONSENT_REQUIRED}返信は送っていません。` };
      const stored = await store.getReview(ctx.salonId, request.reviewId);
      if (stored.kind === "deleted") return { kind: "deleted_on_google", message: DELETED };
      if (stored.kind === "stale" || stored.kind === "not_found") return { kind: "unavailable", message: LOCATION_CHANGED };
      if (stored.kind === "expired") {
        return { kind: "failed", message: "この口コミの一時保存の期限が過ぎています。「Googleで確認する」で取り直してから返信してください。", retryable: false };
      }

      const textSha256 = text ? sha256Hex(text) : null;
      const begun = await store.beginReplyOperation({
        opId: request.opId,
        salonId: ctx.salonId,
        reviewIndexId: request.reviewId,
        action,
        textSha256,
        byteLength: text ? utf8Bytes(text) : null,
        baseReplySha256: replyHash(expected),
        actorUserId: ctx.userId,
        leaseSeconds: REPLY_LEASE_SECONDS,
        ratePerMinute: REPLY_EDITS_PER_MINUTE,
      });
      switch (begun.outcome) {
        case "mismatch":
          return { kind: "mismatch", message: "この操作は受け付けられませんでした(同じ操作の中で内容が変わっています)。画面を読み込み直してから、もう一度お試しください。" };
        case "busy":
          return { kind: "busy", message: "この口コミへの返信を送っている途中です。少し時間をおいて、結果を確認してください。" };
        case "unresolved":
          // 前の送信の結果が分からない。取り直して送った内容が見えるまで、送り直さない・新しく送らない(時間では外さない)。
          return { kind: "busy", message: REPLY_UNRESOLVED };
        case "rate_limited":
          return { kind: "failed", message: "Googleへの返信は、1つの店舗につき1分に10回までです。返信は送っていません。少し時間をおいて、もう一度お試しください。", retryable: true };
        case "not_found":
          return { kind: "unavailable", message: LOCATION_CHANGED };
        case "not_entitled":
          return { kind: "unavailable", message: NOT_ENTITLED };
        case "done":
          return { kind: "accepted", review: await reviewDetailOf(ctx.salonId, request.reviewId), replayed: true };
        case "conflict": {
          const review = await reviewDetailOf(ctx.salonId, request.reviewId);
          return { kind: "conflict", current: review?.reply ?? null, review };
        }
        case "failed":
        case "dismissed":
          return { kind: "failed", message: "この操作は終わっています。もう一度送るときは、確認からやり直してください。", retryable: true };
      }

      const { operationId, leaseToken } = begun;
      const reviewName = stored.review.reviewName;
      // 送っている間に書き直した下書きは消さない(下書きの更新時刻が、読んだときのままのときだけ消す)。
      const draftAtStart = action === "upsert" ? stored.review.draftUpdatedAt : null;
      const detail = () => reviewDetailOf(ctx.salonId, request.reviewId);
      const finish = (status: CompleteReplyStatus, code: string | null, review?: GoogleReviewJson, clearDraft = false) =>
        store.finishReplyOperation(ctx.salonId, operationId, leaseToken, {
          status,
          errorCode: code,
          reviews: review ? [toCachedReview(review, deps.reviewKeySecret)] : [],
          ttlSeconds: GBP_CONTENT_TTL_SECONDS,
          clearDraftUpdatedAt: clearDraft ? draftAtStart : null,
        });
      const stopped = async (): Promise<ReplySubmitResult> => ({ kind: "failed", message: REPLY_STOPPED, retryable: true, review: await detail() });

      // 1. 送る直前に Google から取り直す(外で変わっていないか・前回の送信が反映されていないか)。
      let fresh: GoogleReviewJson;
      try {
        fresh = await withGoogle(ctx.salonId, binding, (token) => api.getReview(token, reviewName));
      } catch (err) {
        if (err instanceof GoogleCallError && err.kind === "not_found") {
          await store.markReviewDeleted(ctx.salonId, request.reviewId);
          await finish("failed", "deleted_on_google");
          return { kind: "deleted_on_google", message: DELETED };
        }
        await finish("failed", "precheck_failed");
        return { kind: "failed", message: callMessage(err, "Googleの最新の返信を確認できなかったため、返信は送っていません。少し時間をおいて、もう一度お試しください。"), retryable: true, review: await detail() };
      }
      // ほかの操作の状態の照らし合わせ(DB)は、ここで済ませる(書き込みの直前の確認と書き込みの間に、DB の待ちを挟まない)。
      await reconcileOperations(ctx.salonId, request.reviewId, fresh);
      const observed = replyHash(fresh.reviewReply?.comment);

      // 2. すでにそうなっている(同じ内容の返信がある・削除済み)なら、送らない。取り直したデータで見えているので確認済み。
      if (action === "upsert" ? observed === textSha256 : observed === null) {
        if (!(await finish("confirmed", "already_same", fresh, action === "upsert"))) return stopped();
        return { kind: "accepted", review: await detail(), replayed: true };
      }
      // 3. 画面で見ていた返信から変わっていたら送らない(外で変わった返信を上書きしない)。
      if (observed !== begun.baseReplySha256) {
        if (!(await finish("conflict", "reply_changed", fresh))) return stopped();
        return { kind: "conflict", current: googleReplyOf(fresh), review: await detail() };
      }

      // 4. 送る。書き込みの直前に、DB で処理権・利用可否・世代を確かめ(送信の開始を記録し、処理権を延ばす)、アプリでも確かめる。
      let checks = 0;
      const check = () =>
        store.startReplySend(ctx.salonId, operationId, leaseToken, {
          windowSeconds: REPLY_WRITE_WINDOW_SECONDS,
          reviews: checks++ === 0 ? [toCachedReview(fresh, deps.reviewKeySecret)] : [],
          ttlSeconds: GBP_CONTENT_TTL_SECONDS,
        });
      const notSent = async (outcome: Exclude<StartSendOutcome, "ok"> | "write_disabled"): Promise<ReplySubmitResult> => {
        if (outcome === "lease_lost") return stopped();
        if (outcome === "not_entitled") return { kind: "unavailable", message: NOT_ENTITLED };
        if (outcome === "location_changed") return { kind: "unavailable", message: LOCATION_CHANGED };
        // このデプロイで書き込みが止められた(GOOGLE_REVIEWS_OAUTH_ENABLED)。送り始める前に止めた。
        await finish("failed", "write_disabled");
        return { kind: "unavailable", message: "Googleへの返信は準備中です。返信は送っていません。" };
      };
      let written: GoogleReviewReplyJson | undefined;
      try {
        if (action === "upsert") {
          const sent = await guardedWrite(ctx.salonId, binding, check, (token) => api.updateReply(token, reviewName, text!));
          if (!sent.sent) return notSent(sent.outcome);
          const reply = sent.value;
          // 応答に審査の状態が無ければ、状態は未確認のまま(取り直して確かめる)。
          written = {
            comment: typeof reply.comment === "string" && reply.comment ? reply.comment : text!,
            updateTime: typeof reply.updateTime === "string" ? reply.updateTime : iso(now()),
            reviewReplyState: reply.reviewReplyState,
            policyViolation: reply.policyViolation,
          };
        } else {
          const sent = await guardedWrite(ctx.salonId, binding, check, (token) => api.deleteReply(token, reviewName));
          if (!sent.sent) return notSent(sent.outcome);
          written = undefined;
        }
      } catch (err) {
        const failure = writeFailure(err);
        if (failure.deleted) await store.markReviewDeleted(ctx.salonId, request.reviewId);
        // 記録できなくても(処理権が切れた)、送れなかった・結果不明という結果は変わらない(成功にはしない)。
        await finish(failure.status, failure.code);
        if (failure.result.kind === "unknown" || failure.result.kind === "failed") return { ...failure.result, review: await detail() };
        return failure.result;
      }

      // 5. 受け付けた(公開されたかは、取り直して確かめるまで分からない)。処理権があるときだけ、状態・一時保存・下書きを
      //    まとめて記録する(連携・店舗が変わっていれば、一時保存・下書きには書き戻さない。DB が確かめる)。
      if (!(await finish("accepted", null, { ...fresh, reviewReply: written }, action === "upsert"))) {
        return { kind: "unknown", message: REPLY_SUPERSEDED, review: await detail() };
      }
      return { kind: "accepted", review: await detail(), replayed: false };
    },

    async dismissReplyOperation(ctx, id) {
      if (!UUID.test(id)) return { ok: false, error: "口コミが見つかりません。" };
      if (!(await consented(ctx.salonId))) return { ok: false, error: CONSENT_REQUIRED };
      try {
        if ((await store.dismissReplyOperations(ctx.salonId, id)) > 0) return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: "取り下げられませんでした。もう一度お試しください。" };
      }
      // 結果不明・送信中・反映を確かめていない操作は、ここでは閉じない(Google で確かめるまで、そのまま)。
      return { ok: false, error: "取り下げられる送信がありません。送信の結果を確認中のときは、「Googleで確認する」で確かめてください。" };
    },
  };
}

/** 403 系の API エラーか(テスト用)。 */
export const isForbiddenKind = (kind: GbpApiErrorKind) => FORBIDDEN_KINDS.has(kind);
