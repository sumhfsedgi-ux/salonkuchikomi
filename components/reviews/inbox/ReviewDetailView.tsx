"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import Avatar from "@/components/ui/Avatar";
import StarRating from "@/components/ui/StarRating";
import EmptyState from "@/components/ui/EmptyState";
import { ChevronLeftIcon, ExternalLinkIcon } from "@/components/ui/icons";
import { useInbox } from "@/components/reviews/inbox/InboxContext";
import { reviewerName } from "@/components/reviews/inbox/ReviewListItem";
import MediaGallery from "@/components/reviews/inbox/MediaGallery";
import ConnectionChangedNotice from "@/components/reviews/inbox/ConnectionChangedNotice";
import ReviewComposer, { type ComposerActions, type ComposerTarget } from "@/components/reviews/inbox/ReviewComposer";
import { formatReviewDate, isEdited } from "@/lib/googleReviews/format";
import { withQuery } from "@/lib/googleReviews/query";
import { CONNECTION_CHANGED_MESSAGE, isConnectionChangedMessage } from "@/lib/googleReviews/messages";
import type { ActionResult, ReviewDetail, ReviewDetailResult } from "@/lib/googleReviews/types";

// 口コミの詳細(計画 第2版 §2)。
//   ・開いたときだけ既読にする(一覧を見ただけ・自動では既読にしない)。開いた新着は新着から外れる。「未読に戻す」は補助の操作として小さく置く。
//   ・1列のときは「‹ 一覧へ」を出し、見出しにフォーカスする。一覧から来たときは履歴を戻る。
//   ・Google 上で削除された・期限切れ・見つからない・連携や店舗が変わった、も画面が崩れないように表示する。
//   ・一覧の世代(InboxContext の locationId)と違う口コミは表示しない(計画 第2版 §3-A)。

export interface DetailActions extends ComposerActions {
  setSeen: (id: string, seen: boolean) => Promise<ActionResult>;
  checkReview: (id: string) => Promise<ActionResult<ReviewDetail>>;
}

interface Props {
  id: string;
  result: ReviewDetailResult;
  actions: DetailActions;
  target: ComposerTarget;
}

function BackLink() {
  const router = useRouter();
  const { basePath, query, twoColumn, cameFromList } = useInbox();
  if (twoColumn) return null;
  const href = withQuery(basePath, query);
  return (
    <Link
      href={href}
      onClick={(e) => {
        if (cameFromList()) {
          e.preventDefault();
          router.back();
        }
      }}
      className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-sage-dark"
    >
      <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
      一覧へ
    </Link>
  );
}

function MissingState({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  const { basePath, query } = useInbox();
  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      <Card>
        <EmptyState
          title={title}
          description={description}
          actions={
            <>
              {children}
              <Link href={withQuery(basePath, query)} className="text-sm font-medium text-sage-dark underline underline-offset-2">
                一覧に戻る
              </Link>
            </>
          }
        />
      </Card>
    </div>
  );
}

function RefetchButton({ id, checkReview, onDone }: { id: string; checkReview: DetailActions["checkReview"]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setMessage(null);
    let res: ActionResult<ReviewDetail>;
    try {
      res = await checkReview(id);
    } catch {
      res = { ok: false, error: "Googleから口コミを取り直せませんでした。少し時間をおいて、もう一度お試しください。" };
    }
    setBusy(false);
    if (res.ok) onDone();
    else setMessage(res.error);
  }
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <Button type="button" size="sm" variant="secondary" onClick={run} disabled={busy}>
        {busy ? "取り直しています…" : "Googleから取り直す"}
      </Button>
      {message && (
        <p role="status" className="text-sm text-ink-muted">
          {message}
        </p>
      )}
    </div>
  );
}

export default function ReviewDetailView({ id, result, actions, target }: Props) {
  const router = useRouter();
  const { twoColumn, updateItem, nextUnrepliedHref, basePath, query, locationId } = useInbox();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const initial = result.kind === "ok" ? result.review : null;
  const [review, setReview] = useState<ReviewDetail | null>(initial);
  const [unread, setUnread] = useState(initial?.unread ?? false);
  const [seenStatus, setSeenStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const markedSeen = useRef(false);
  const otherGeneration = initial !== null && locationId !== null && initial.locationId !== locationId;

  // 開いたら既読にする(1回だけ)。
  useEffect(() => {
    if (!initial || otherGeneration || !initial.unread || markedSeen.current) return;
    markedSeen.current = true;
    void actions.setSeen(id, true).then((res) => {
      if (res.ok) {
        setUnread(false);
        updateItem(id, { unread: false, isNew: false });
      }
    });
  }, [actions, id, initial, otherGeneration, updateItem]);

  // 1列のとき、詳細を開いたら見出しにフォーカスする。
  useEffect(() => {
    if (!twoColumn) headingRef.current?.focus({ preventScroll: true });
  }, [twoColumn, id]);

  if (otherGeneration) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ConnectionChangedNotice message={CONNECTION_CHANGED_MESSAGE} reloadHref={withQuery(basePath, query)} />
      </div>
    );
  }
  if (result.kind === "not_found") {
    return <MissingState title="この口コミは表示できません" description="見つからないか、Google連携または店舗が変わった可能性があります。一覧から選び直してください。" />;
  }
  if (result.kind === "unavailable_content") {
    return (
      <MissingState
        title="口コミの内容を表示できません"
        description="Googleの口コミは一時保存の期限(25日)を過ぎると消しています。Googleから取り直すと、もう一度表示できます。"
      >
        <RefetchButton id={id} checkReview={actions.checkReview} onDone={() => router.refresh()} />
      </MissingState>
    );
  }
  if (result.kind === "deleted_on_google") {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert variant="warning">
          この口コミはGoogle上で削除されました。{result.draft ? "書いていた下書きは下に表示しています(期限まで残ります)。" : ""}
        </Alert>
        {result.draft && (
          <Card className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-ink">書いていた下書き</p>
            <p className="whitespace-pre-wrap break-words text-sm text-ink">{result.draft}</p>
          </Card>
        )}
      </div>
    );
  }

  if (!review) return null;

  async function checkLatest() {
    setChecking(true);
    setCheckError(null);
    let res: ActionResult<ReviewDetail>;
    try {
      res = await actions.checkReview(id);
    } catch {
      res = { ok: false, error: "最新の状態を取得できませんでした。" };
    }
    setChecking(false);
    if (!res.ok) {
      setCheckError(res.error);
      return;
    }
    const next = res.value;
    setReview((prev) =>
      prev ? { ...prev, reply: next.reply, operation: next.operation, bucket: next.bucket, replyUrl: next.replyUrl, comment: next.comment, starRating: next.starRating, updateTime: next.updateTime } : prev,
    );
    updateItem(id, { reply: next.reply, operation: next.operation, bucket: next.bucket, comment: next.comment, starRating: next.starRating, updateTime: next.updateTime });
    setLastCheckedAt(new Date().toISOString());
  }

  async function markUnread() {
    const res = await actions.setSeen(id, false);
    if (res.ok) {
      setUnread(true);
      updateItem(id, { unread: true });
      setSeenStatus("未読に戻しました");
    } else {
      setSeenStatus(res.error);
    }
  }

  const name = reviewerName(review);
  const hasText = review.comment.trim().length > 0;

  return (
    <article className="flex flex-col gap-4" aria-labelledby={`review-heading-${review.id}`}>
      <BackLink />
      <Card className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Avatar name={review.reviewer.displayName} photoUrl={review.reviewer.photoUrl} size="md" />
          <div className="min-w-0 flex-1">
            <h2
              id={`review-heading-${review.id}`}
              ref={headingRef}
              tabIndex={-1}
              className="break-words text-base font-semibold text-ink focus:outline-none"
            >
              {name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
              <StarRating value={review.starRating} size="md" />
              <span>{formatReviewDate(review.createTime)}</span>
              {isEdited(review.createTime, review.updateTime) && <span>({formatReviewDate(review.updateTime)}に編集)</span>}
              <span>Googleの口コミ</span>
            </div>
          </div>
        </div>
        {hasText ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{review.comment}</p>
        ) : (
          <p className="text-sm text-ink-muted">★のみの口コミです(本文はありません)。</p>
        )}
        <MediaGallery items={review.media} googleUrl={review.replyUrl} />
        {/* 補助の操作(主な操作の「返信」より目立たせない) */}
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span role="status" aria-live="polite">
            {seenStatus ?? ""}
          </span>
          {review.replyUrl && (
            <a href={review.replyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink">
              Googleで口コミを開く
              <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          )}
          {!unread && (
            <button type="button" onClick={markUnread} className="underline underline-offset-2 hover:text-ink">
              未読に戻す
            </button>
          )}
        </div>
      </Card>

      {checkError &&
        (isConnectionChangedMessage(checkError) ? (
          <ConnectionChangedNotice message={checkError} reloadHref={withQuery(basePath, query)} />
        ) : (
          <Alert variant="error">{checkError}</Alert>
        ))}

      <ReviewComposer
        key={review.id}
        review={review}
        target={target}
        actions={actions}
        onCheckLatest={checkLatest}
        checking={checking}
        lastCheckedAt={lastCheckedAt}
        onDraftSaved={(hasDraft) => updateItem(review.id, { hasDraft })}
        onReviewUpdated={(next) => {
          setReview(next);
          updateItem(next.id, { reply: next.reply, operation: next.operation, bucket: next.bucket, hasDraft: next.hasDraft });
        }}
        nextUnrepliedHref={nextUnrepliedHref(review.id)}
        listHref={withQuery(basePath, query)}
      />
    </article>
  );
}
