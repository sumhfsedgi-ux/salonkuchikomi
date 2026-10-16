"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import Avatar from "@/components/ui/Avatar";
import StarRating from "@/components/ui/StarRating";
import { CameraIcon, PencilIcon, PlayIcon } from "@/components/ui/icons";
import ReplyStatusBadge from "@/components/reviews/inbox/ReplyStatusBadge";
import { matchesFilter, replyDisplayState } from "@/lib/googleReviews/replyState";
import { formatReviewDate, isEdited } from "@/lib/googleReviews/format";
import { reviewDetailPath } from "@/lib/googleReviews/query";
import type { ReviewListQuery, ReviewSummary } from "@/lib/googleReviews/types";

// 一覧の1行。優先する情報は 投稿者・★・本文・返信の状態。
// 新着・写真・動画・下書き・編集は補助の情報として小さく出す。
// 選択中・未読は色だけでなく、左の線・太字・点・読み上げ用の文字で区別する。

export function reviewerName(review: Pick<ReviewSummary, "reviewer">): string {
  return review.reviewer.displayName?.trim() || "Googleユーザー";
}

interface Props {
  review: ReviewSummary;
  query: ReviewListQuery;
  selected: boolean;
  onSelect: (id: string) => void;
  basePath?: string;
}

export default function ReviewListItem({ review, query, selected, onSelect, basePath }: Props) {
  const state = replyDisplayState(review);
  const name = reviewerName(review);
  const stale = !matchesFilter(review, query.filter);
  const hasText = review.comment.trim().length > 0;

  return (
    <li>
      <Link
        href={reviewDetailPath(review.id, query, basePath)}
        data-review-id={review.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(review.id)}
        className={cn(
          "flex gap-3 border-l-2 px-3 py-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sage/50",
          selected ? "border-sage bg-sage-soft" : "border-transparent hover:bg-ivory",
          stale && !selected && "opacity-70",
        )}
      >
        <Avatar name={review.reviewer.displayName} photoUrl={review.reviewer.photoUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {review.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-sage" aria-hidden="true" />}
            {review.unread && <span className="sr-only">未読</span>}
            <span className={cn("min-w-0 flex-1 truncate text-sm text-ink", review.unread ? "font-semibold" : "font-medium")}>
              {name}
            </span>
            {review.isNew && (
              <span className="shrink-0 rounded-full bg-sage-soft px-2 py-0.5 text-xs font-medium text-sage-dark">新着</span>
            )}
            <span className="shrink-0 text-xs text-ink-muted">{formatReviewDate(review.createTime)}</span>
          </div>
          <StarRating value={review.starRating} className="mt-0.5" />
          <p className={cn("mt-1 line-clamp-2 break-words text-sm", hasText ? "text-ink-muted" : "text-ink-muted/80")}>
            {hasText ? review.comment : "(★のみ・本文なし)"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <ReplyStatusBadge state={state} />
            {review.photoCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                <CameraIcon className="h-3.5 w-3.5" aria-hidden="true" />
                写真{review.photoCount}
              </span>
            )}
            {review.videoCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                <PlayIcon className="h-3.5 w-3.5" aria-hidden="true" />
                動画{review.videoCount}
              </span>
            )}
            {review.hasDraft && (
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                <PencilIcon className="h-3.5 w-3.5" aria-hidden="true" />
                下書きあり
              </span>
            )}
            {isEdited(review.createTime, review.updateTime) && <span className="text-xs text-ink-muted">投稿者が編集</span>}
          </div>
          {stale && <p className="mt-1 text-xs text-ink-muted">状態が変わりました(次に読み込むと、この一覧から外れます)</p>}
        </div>
      </Link>
    </li>
  );
}
