import type { GoogleReviewJson } from "@/lib/gbp/apiClient";
import type { CachedReviewInput, StoredReviewDetail, StoredReviewSummary } from "@/lib/gbp/store";
import { reviewKeyFor } from "@/lib/gbp/reviewKey";
import type { GoogleReplyState, ReviewDetail, ReviewSummary, StarRatingValue } from "@/lib/googleReviews/types";

// Google の口コミ(v4 の Review)と、一時保存・画面の形の変換。
// 口コミのキーは Google のリソース名の HMAC(reviewKeyFor)。Google の ID そのものは索引に入れない。

const STARS: Record<string, StarRatingValue> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const REPLY_STATES = new Set<GoogleReplyState>(["PENDING", "APPROVED", "REJECTED", "UNSPECIFIED"]);
const HTTPS = /^https:\/\/[^\s]+$/;

const httpsOrNull = (value: unknown) => (typeof value === "string" && HTTPS.test(value) ? value : null);

export function toCachedReview(review: GoogleReviewJson, reviewKeySecret: string | undefined): CachedReviewInput {
  const reply = review.reviewReply;
  const replyState = reply?.comment
    ? REPLY_STATES.has(reply.reviewReplyState as GoogleReplyState)
      ? (reply.reviewReplyState as GoogleReplyState)
      : "UNSPECIFIED"
    : null;
  const anonymous = review.reviewer?.isAnonymous === true;
  return {
    reviewKey: reviewKeyFor(review.name, reviewKeySecret),
    reviewName: review.name,
    reviewerName: anonymous ? null : review.reviewer?.displayName?.trim() || null,
    reviewerPhotoUrl: anonymous ? null : httpsOrNull(review.reviewer?.profilePhotoUrl),
    isAnonymous: anonymous,
    starRating: review.starRating ? (STARS[review.starRating] ?? null) : null,
    comment: typeof review.comment === "string" ? review.comment : "",
    createTime: review.createTime,
    updateTime: review.updateTime || review.createTime,
    replyComment: reply?.comment ? reply.comment : null,
    replyUpdateTime: reply?.comment && reply.updateTime ? reply.updateTime : null,
    replyState,
    policyViolation: replyState === "REJECTED" && typeof reply?.policyViolation === "string" ? reply.policyViolation : null,
    media: (review.reviewMediaItems ?? [])
      .filter((m) => httpsOrNull(m.thumbnailUrl))
      .map((m) => ({ thumbnailUrl: m.thumbnailUrl!, label: m.thumbnailLabel?.trim() || null, videoUrl: httpsOrNull(m.videoUrl) })),
    replyUrl: httpsOrNull(review.reviewReplyUrl),
  };
}

export function toReviewSummary(row: StoredReviewSummary): ReviewSummary {
  const stars = row.starRating;
  return {
    id: row.reviewIndexId,
    locationId: row.locationId,
    reviewer: { displayName: row.reviewerName, photoUrl: row.reviewerPhotoUrl, isAnonymous: row.isAnonymous },
    starRating: stars !== null && stars >= 1 && stars <= 5 ? (stars as StarRatingValue) : null,
    comment: row.comment,
    createTime: row.createTime,
    updateTime: row.updateTime,
    photoCount: row.media.filter((m) => !m.videoUrl).length,
    videoCount: row.media.filter((m) => m.videoUrl).length,
    unread: row.unread,
    isNew: row.isNew,
    hasDraft: row.hasDraft,
    reply: row.replyComment
      ? {
          comment: row.replyComment,
          updateTime: row.replyUpdateTime ?? row.updateTime,
          state: row.replyState ?? "UNSPECIFIED",
          policyViolation: row.replyState === "REJECTED" ? row.policyViolation : null,
        }
      : null,
    operation: row.operation,
    bucket: row.bucket,
  };
}

export function toReviewDetail(row: StoredReviewDetail): ReviewDetail {
  return {
    ...toReviewSummary(row),
    media: row.media,
    replyUrl: row.replyUrl,
    draft: row.draft,
    draftUpdatedAt: row.draftUpdatedAt,
  };
}
