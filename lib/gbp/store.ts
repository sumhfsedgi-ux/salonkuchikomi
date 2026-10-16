import type {
  GoogleReplyState,
  ReplyOperationState,
  ReviewBucket,
  ReviewFilter,
  ReviewMediaItem,
  ReviewRatingFilter,
  ReviewSort,
} from "@/lib/googleReviews/types";

// 届いた口コミのデータの置き場所(DB の関数。supabase/migrations/0028・0029)。DB とのやり取りは supabaseStore.ts だけ。
// salonId・userId は必ずサーバーで確定した値(ログイン中のセッションから解決し、利用可否の判定を通った値)を渡すこと。
// 口コミの ID(reviewIndexId)はクライアントから来るが、どのメソッドも salonId で絞る(ほかの店舗のものは見つからない)。
// 書き込みは、どれも DB の側で「選択の世代が使えるか」(gbp_location_usable)を確かめる。

/** Google から取った口コミを一時保存するための形(Google のデータ。25日で消える)。 */
export interface CachedReviewInput {
  reviewKey: string;
  reviewName: string;
  reviewerName: string | null;
  reviewerPhotoUrl: string | null;
  isAnonymous: boolean;
  starRating: number | null;
  comment: string;
  createTime: string;
  updateTime: string;
  replyComment: string | null;
  replyUpdateTime: string | null;
  replyState: GoogleReplyState | null;
  policyViolation: string | null;
  media: ReviewMediaItem[];
  replyUrl: string | null;
}

export interface UpsertedReview {
  reviewIndexId: string;
  reviewKey: string;
  created: boolean;
}

/** 今の店舗(使える世代)の情報(gbp_inbox_summary)。 */
export interface InboxSummaryRow {
  locationId: string;
  googleAccountId: string;
  accountName: string;
  locationName: string;
  title: string | null;
  averageRating: number | null;
  totalReviewCount: number | null;
  ratingCachedAt: string | null;
  lastSyncedAt: string | null;
  initialSyncDone: boolean;
  syncInProgress: boolean;
  hasExpired: boolean;
  newCount: number | null;
}

export interface StoredReviewSummary {
  reviewIndexId: string;
  locationId: string;
  reviewerName: string | null;
  reviewerPhotoUrl: string | null;
  isAnonymous: boolean;
  starRating: number | null;
  comment: string;
  createTime: string;
  updateTime: string;
  replyComment: string | null;
  replyUpdateTime: string | null;
  replyState: GoogleReplyState | null;
  policyViolation: string | null;
  media: ReviewMediaItem[];
  unread: boolean;
  isNew: boolean;
  hasDraft: boolean;
  operation: ReplyOperationState;
  bucket: ReviewBucket;
}

export interface StoredReviewDetail extends StoredReviewSummary {
  reviewName: string;
  replyUrl: string | null;
  draft: string;
  draftUpdatedAt: string | null;
}

export type StoredReview =
  | { kind: "not_found" }
  /** 選択の世代が使えない(連携・店舗が変わった)。内容は返さない。 */
  | { kind: "stale" }
  | { kind: "deleted"; draft: string }
  | { kind: "expired"; locationId: string }
  | { kind: "ok"; review: StoredReviewDetail };

export interface ListQueryInput {
  filter: ReviewFilter;
  rating: ReviewRatingFilter;
  sort: ReviewSort;
  offset: number;
  limit: number;
}

export type SyncRunKind = "full" | "delta";

export interface SyncBeginInput {
  leaseSeconds: number;
  /** 最後に最後まで読んでからこれだけ経ったら、次の同期は全件を読む(一時保存の期限より短くする)。 */
  fullRescanAfterSeconds: number;
  /** 新しい同期を始める最短の間隔(途中の同期の続きには使わない)。 */
  minIntervalSeconds: number;
  /** 差分の同期で、前回の watermark より少し前から読む重なり。 */
  overlapSeconds: number;
}

/**
 * 同期(run)の開始・続き。
 *   started / continued : 処理権を得た。pageToken から読む(null なら先頭)。resumeBefore より新しいだけのページは読み終えている
 *   busy                : ほかの同期が処理権を持っている(または失敗のあとで待っている)
 *   throttled           : 途中の同期が無く、前回の確認から最短の間隔が経っていない
 *   inactive            : 使える世代ではない
 */
export type SyncBegin =
  | { status: "started" | "continued"; leaseToken: string; kind: SyncRunKind; floor: string | null; resumeBefore: string | null; pageToken: string | null }
  | { status: "busy" }
  | { status: "inactive" }
  | { status: "throttled"; lastSyncedAt: string | null };

export interface SyncCheckpointInput {
  pageToken: string;
  resumeBefore: string | null;
  newest: string | null;
  averageRating: number | null;
  totalReviewCount: number | null;
}

export interface SyncFinishInput {
  newest: string | null;
  averageRating: number | null;
  totalReviewCount: number | null;
}

export interface SyncReleaseInput {
  contacted: boolean;
  failed: boolean;
  holdSeconds: number;
}

export type SelectLocationResult = { ok: true; locationId: string } | { ok: false; reason: "binding_changed" | "linked_elsewhere" };

export type ReplyOperationAction = "upsert" | "delete";

export interface BeginReplyOperationInput {
  opId: string;
  salonId: string;
  reviewIndexId: string;
  action: ReplyOperationAction;
  textSha256: string | null;
  byteLength: number | null;
  baseReplySha256: string | null;
  actorUserId: string;
  leaseSeconds: number;
  ratePerMinute: number;
}

/** 返信の操作を始める(0029 の gbp_begin_reply_operation)。 */
export type BeginReplyOperation =
  | { outcome: "new"; operationId: string; leaseToken: string; baseReplySha256: string | null }
  | { outcome: "done"; operationId: string }
  | { outcome: "failed"; operationId: string }
  | { outcome: "conflict"; operationId: string }
  | { outcome: "dismissed"; operationId: string }
  | { outcome: "busy" }
  /** 前の操作の結果が分からない(Google から取り直して送った内容が見えるまで、送り直さない・新しく始めない)。 */
  | { outcome: "unresolved" }
  | { outcome: "mismatch" }
  | { outcome: "rate_limited" }
  | { outcome: "not_found" }
  | { outcome: "not_entitled" };

export type CompleteReplyStatus = "accepted" | "confirmed" | "unknown" | "failed" | "conflict";

/** 送る直前の確認の結果(0029 の gbp_reply_start_send)。ok 以外は送らない。 */
export type StartSendOutcome = "ok" | "lease_lost" | "not_entitled" | "location_changed";

export interface ObservedReply {
  replySha256: string | null;
  replyState: GoogleReplyState | null;
  replyUpdateTime: string | null;
}

export interface StartReplySendInput {
  windowSeconds: number;
  reviews: CachedReviewInput[];
  ttlSeconds: number;
}

export interface FinishReplyInput {
  status: CompleteReplyStatus;
  errorCode: string | null;
  reviews: CachedReviewInput[];
  ttlSeconds: number;
  clearDraftUpdatedAt: string | null;
}

/** 口コミを初めて見つけた経路(0028 の gbp_review_index.detected_via)。 */
export type DetectedVia = "manual" | "reconcile" | "pubsub";

export interface GbpStore {
  recordConsent(salonId: string, userId: string, version: string): Promise<void>;
  hasConnectConsent(salonId: string, version: string): Promise<boolean>;
  /** 今の店舗(使える世代)。無ければ null。 */
  getInboxSummary(salonId: string): Promise<InboxSummaryRow | null>;
  isLocationLinkedElsewhere(locationName: string, salonId: string): Promise<boolean>;
  selectLocation(input: {
    salonId: string;
    googleAccountId: string;
    accountName: string;
    locationName: string;
    title: string;
    address: string | null;
    userId: string;
  }): Promise<SelectLocationResult>;
  /** 店舗の選び直しを始める(口コミの結び付けを選択待ちに戻す。今の世代は DB のトリガーが無効にして消す)。 */
  beginLocationChange(salonId: string, googleAccountId: string): Promise<boolean>;
  /** 世代が使えなければ GbpLocationInactiveError、同期の処理権を失っていれば GbpSyncLeaseLostError。 */
  /** detectedVia: 初めて見つけた経路(索引の detected_via。手動の更新は manual、自動取得は reconcile、Google の通知は pubsub)。 */
  ingestReviews(
    salonId: string,
    locationId: string,
    syncLeaseToken: string | null,
    reviews: CachedReviewInput[],
    ttlSeconds: number,
    detectedVia?: DetectedVia,
  ): Promise<UpsertedReview[]>;
  beginSync(salonId: string, locationId: string, input: SyncBeginInput): Promise<SyncBegin>;
  checkpointSync(salonId: string, locationId: string, leaseToken: string, input: SyncCheckpointInput, leaseSeconds: number): Promise<boolean>;
  finishSync(salonId: string, locationId: string, leaseToken: string, input: SyncFinishInput): Promise<string | null>;
  releaseSync(salonId: string, locationId: string, leaseToken: string, input: SyncReleaseInput): Promise<string | null>;
  updateLocationInfo(salonId: string, locationId: string, title: string, address: string | null): Promise<boolean>;
  /** 次のページがあるか分かるよう、limit + 1 件まで返す。 */
  listReviews(salonId: string, query: ListQueryInput): Promise<StoredReviewSummary[]>;
  getReview(salonId: string, reviewIndexId: string): Promise<StoredReview>;
  setSeen(salonId: string, reviewIndexId: string, seen: boolean): Promise<boolean>;
  /** 空なら消す。使える世代の口コミでなければ null(保存しない)。 */
  saveDraft(salonId: string, reviewIndexId: string, text: string, ttlSeconds: number): Promise<string | null>;
  markReviewDeleted(salonId: string, reviewIndexId: string): Promise<boolean>;
  beginReplyOperation(input: BeginReplyOperationInput): Promise<BeginReplyOperation>;
  startReplySend(salonId: string, operationId: string, leaseToken: string, input: StartReplySendInput): Promise<StartSendOutcome>;
  finishReplyOperation(salonId: string, operationId: string, leaseToken: string, input: FinishReplyInput): Promise<boolean>;
  /**
   * Google から取り直した直後のデータ(observed)で、その口コミの操作の状態を確かめる。送った内容が見えれば確認済み。
   * 結果不明の操作は、見えない限り結果不明のまま(時間では変えない)。
   */
  reconcileReplyOperations(salonId: string, reviewIndexId: string, observed: ObservedReply): Promise<number>;
  /** 反映されていないと分かっている操作(failed)だけを閉じる(「送るのをやめる」)。閉じた数を返す。 */
  dismissReplyOperations(salonId: string, reviewIndexId: string): Promise<number>;
  deactivateSalonLocations(salonId: string): Promise<number>;
  purgeExpiredContent(): Promise<Record<string, number>>;
}

export class GbpStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null = null,
  ) {
    super(`gbp store: ${operation} failed`);
    this.name = "GbpStoreError";
  }
}

/** 選択の世代が使えない(連携・店舗が変わった)。書き込んでいない。 */
export class GbpLocationInactiveError extends GbpStoreError {
  constructor(operation: string) {
    super(operation, "location_inactive");
    this.name = "GbpLocationInactiveError";
  }
}

/** 同期の処理権を失った(ほかの同期が続きを読む)。書き込んでいない。 */
export class GbpSyncLeaseLostError extends GbpStoreError {
  constructor(operation: string) {
    super(operation, "sync_lease_lost");
    this.name = "GbpSyncLeaseLostError";
  }
}

/** Google のデータ(口コミの内容・下書き)を一時保存する期間。30日の制限より短くする。 */
export const GBP_CONTENT_TTL_SECONDS = 25 * 24 * 60 * 60;
/** 最後に全件を読んでから、次に全件を読み直すまでの日数(一時保存の25日より前に、すべての口コミを取り直す)。 */
export const GBP_FULL_RESCAN_AFTER_SECONDS = 20 * 24 * 60 * 60;
