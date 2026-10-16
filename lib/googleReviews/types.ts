// 届いた口コミの画面で使う型(計画 第2版 §2)。画面はこの型だけを見る。データの取り方は lib/gbp/inbox.ts。

export type StarRatingValue = 1 | 2 | 3 | 4 | 5;

export interface GbpLocationOption {
  /** Google のロケーションのリソース名(locations/{id})。 */
  locationName: string;
  title: string;
  address: string | null;
  /** 選べない理由。null なら選べる。 */
  unavailableReason: "unverified" | "linked_elsewhere" | null;
}

export interface GbpAccountOption {
  accountName: string;
  displayName: string;
  locations: GbpLocationOption[];
}

export interface GbpLinkedLocation {
  title: string | null;
  address: string | null;
}

/**
 * 届いた口コミの Google 連携の状態(共通の Google 連携の、口コミの結び付けから決める)。
 *   not_connected  : 口コミの結び付けが無い(連携の案内を出す)
 *   needs_reconnect: Google アカウント全体の認可が使えない(再連携が必要)
 *   scope_missing  : 口コミの権限だけが足りない(権限を追加する)
 *   selecting      : 認可は済んだが、店舗(ロケーション)をまだ選んでいない
 *   connected      : 店舗を選んで使える
 */
export type GbpConnectionState =
  | { kind: "not_connected" }
  | { kind: "needs_reconnect"; googleEmail: string | null }
  | { kind: "scope_missing"; googleEmail: string | null }
  /** 連携はできているが、口コミの取り扱いの同意(今の版)を記録していない。Google の口コミの API は呼んでいない。 */
  | { kind: "consent_required"; googleEmail: string | null }
  | { kind: "selecting"; googleEmail: string | null; accounts: GbpAccountOption[]; loadError?: string }
  | { kind: "connected"; googleEmail: string | null; location: GbpLinkedLocation; connectedAt: string };

/** Google 上の返信の審査状態(reviewReplyState)。 */
export type GoogleReplyState = "PENDING" | "APPROVED" | "REJECTED" | "UNSPECIFIED";

export interface GoogleReply {
  comment: string;
  updateTime: string;
  state: GoogleReplyState;
  /** REJECTED のときだけ入る(policyViolation)。 */
  policyViolation: string | null;
}

/**
 * SalonPack から Google への返信の操作の状態(DB の gbp_reply_op_display と同じ)。Google 上の審査の状態とは別の軸。
 *   sending        : 送っている途中
 *   unknown        : 結果が分からない(時間切れ・通信の切断など)
 *   sent_checking  : Google が受け付けた。反映(審査の状態)は、まだ取り直して確かめていない
 *   send_failed    : 送れなかった(反映されていないと分かっている)。Google 上に返信が無い
 *   replace_failed : 置き換えが失敗し、以前の返信が Google に残っている
 *   delete_failed  : 削除が失敗し、返信が Google に残っている
 */
export type ReplyOperationState = "none" | "sending" | "unknown" | "sent_checking" | "send_failed" | "replace_failed" | "delete_failed";

/** 絞り込みの分類(DB の gbp_reply_bucket と同じ)。 */
export type ReviewBucket = "unreplied" | "attention" | "replied";

export interface ReviewMediaItem {
  thumbnailUrl: string;
  label: string | null;
  /** 動画なら再生用の URL。写真なら null。 */
  videoUrl: string | null;
}

export interface Reviewer {
  displayName: string | null;
  photoUrl: string | null;
  isAnonymous: boolean;
}

export interface ReviewSummary {
  /** SalonPack 側の ID(URL に使う)。Google の ID ではない。 */
  id: string;
  /** 選択の世代(ロケーションの行の ID)。画面は、今の世代と違う結果を表示しない。 */
  locationId: string;
  reviewer: Reviewer;
  starRating: StarRatingValue | null;
  comment: string;
  createTime: string;
  updateTime: string;
  photoCount: number;
  videoCount: number;
  unread: boolean;
  /** 初回の取り込みのあとに見つけ、まだ開いていない口コミ。 */
  isNew: boolean;
  hasDraft: boolean;
  reply: GoogleReply | null;
  operation: ReplyOperationState;
  bucket: ReviewBucket;
}

export interface ReviewDetail extends ReviewSummary {
  media: ReviewMediaItem[];
  /** Google の返信画面の URL(reviewReplyUrl)。取れなければ null。 */
  replyUrl: string | null;
  /** 保存している下書き(返信欄の文章)。 */
  draft: string;
  draftUpdatedAt: string | null;
}

export type ReviewFilter = "unreplied" | "attention" | "replied" | "all" | "new";
export type ReviewRatingFilter = "all" | "5" | "4" | "3" | "low";
export type ReviewSort = "newest" | "lowest";

export interface ReviewListQuery {
  filter: ReviewFilter;
  rating: ReviewRatingFilter;
  sort: ReviewSort;
}

/** 画面の上部の情報。数字は取得できたものだけ(取得できない数字は null にし、0 として表示しない)。 */
export interface InboxSummary {
  locationId: string;
  location: GbpLinkedLocation;
  /** Google の値そのまま(reviews.list の averageRating / totalReviewCount。店舗全体の値)。 */
  averageRating: number | null;
  totalReviewCount: number | null;
  /** 上の2つを Google から取った時刻。 */
  ratingAt: string | null;
  /** 最後に Google から口コミを取り込んだ時刻(最後まで読み終えた、または途中まで読んだ)。 */
  lastCheckedAt: string | null;
  initialSyncDone: boolean;
  /** 取り込みが途中(続きがある)。 */
  syncIncomplete: boolean;
  /** 一時保存の期限(25日)が切れて、表示から外している口コミがある。 */
  contentExpired: boolean;
  /** 新着の数(初回の取り込みが終わっていなければ null)。 */
  newCount: number | null;
}

export type ReviewListResult =
  | { kind: "ok"; items: ReviewSummary[]; nextCursor: string | null; summary: InboxSummary; noReviewsAtAll: boolean }
  /** 店舗を選んだ直後で、まだ1件も取り込めていない。 */
  | { kind: "initial_sync"; summary: InboxSummary }
  | { kind: "error"; message: string }
  /** 連携していない・店舗を選んでいない。 */
  | { kind: "not_connected" };

export type ReviewDetailResult =
  | { kind: "ok"; review: ReviewDetail }
  /** Google 上で削除された。下書きだけは残っていることがある。 */
  | { kind: "deleted_on_google"; draft: string }
  /** 一時保存の期限が切れた(取り直しが要る)。 */
  | { kind: "unavailable_content" }
  /** 見つからない・ほかの店舗の口コミ・連携や店舗が変わった。 */
  | { kind: "not_found" };

export type ActionResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

export interface ReplySubmitRequest {
  reviewId: string;
  /** 確認ダイアログを開いたときに画面が作る ID。同じ操作の再送は同じ ID で送る。 */
  opId: string;
  action: "upsert" | "delete";
  /** upsert のときの返信の本文。 */
  text: string | null;
  /** 確認ダイアログで表示していた Google の返信(無ければ null)。送る直前に取り直して、外で変わっていないかを比べる。 */
  expectedReply: string | null;
}

export type ReplySubmitResult =
  /** Google の API が受け付けた(公開されたかは別。review.operation が sent_checking のあいだは未確認)。 */
  | { kind: "accepted"; review: ReviewDetail | null; replayed: boolean }
  /** 送る直前に取り直したら、Google の返信が画面で見ていたものから変わっていた(何も送っていない)。 */
  | { kind: "conflict"; current: GoogleReply | null; review: ReviewDetail | null }
  /** 反映されたかどうか分からない(時間切れ・通信の切断など)。取り直して確かめるまで、もう一度送らない。 */
  | { kind: "unknown"; message: string; review?: ReviewDetail | null }
  | { kind: "failed"; message: string; retryable: boolean; review?: ReviewDetail | null }
  | { kind: "busy"; message: string }
  /** 同じ操作の ID で、口コミ・操作・本文が違う(Google には何も送っていない)。 */
  | { kind: "mismatch"; message: string }
  | { kind: "deleted_on_google"; message: string }
  /** 連携・店舗が変わった、利用できない、など(送っていない)。 */
  | { kind: "unavailable"; message: string };
