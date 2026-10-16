"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import Button from "@/components/ui/Button";
import { ChevronLeftIcon, ExternalLinkIcon, PlayIcon } from "@/components/ui/icons";
import type { ReviewMediaItem } from "@/lib/googleReviews/types";
import { useImageFailure } from "@/lib/useImageFailure";

// 口コミの写真・動画(docs/plans/google-reviews-inbox-plan.md §4・§8-4)。
//   ・Google の URL を <img>/<video> で直接表示する(複製しない。next/image の最適化も通さない)。
//   ・1枚なら幅いっぱい、複数なら 96px のサムネイルを横スクロール。動画は再生アイコンと「動画」の文字。
//   ・タップ／Enter で拡大表示(左右送り・←/→・Esc・閉じたら開いたボタンへフォーカスを戻す)。
//   ・読み込みに失敗した写真は、大きな枠を残さず、小さな「写真を読み込めませんでした」と［再読み込み］・「Googleで見る」に置き換える。

interface Props {
  items: ReviewMediaItem[];
  googleUrl: string | null;
}

function Thumb({
  item,
  index,
  large,
  onFail,
  onOpen,
}: {
  item: ReviewMediaItem;
  index: number;
  large: boolean;
  onFail: () => void;
  onOpen: (index: number, trigger: HTMLButtonElement) => void;
}) {
  const label = item.label?.trim() || (item.videoUrl ? "口コミの動画" : "口コミの写真");
  const box = large ? "h-56 w-full sm:h-72" : "h-24 w-24 shrink-0";
  const imgRef = useImageFailure<HTMLImageElement>(onFail);
  return (
    <button
      type="button"
      onClick={(e) => onOpen(index, e.currentTarget)}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-beige focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 focus-visible:ring-offset-2 focus-visible:ring-offset-ivory",
        box,
      )}
      aria-label={`${label}を拡大して見る`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Google の画像は複製・最適化しない(GBP の保存の制限) */}
      <img
        ref={imgRef}
        src={item.thumbnailUrl}
        alt={label}
        className="h-full w-full object-cover"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={onFail}
      />
      {item.videoUrl && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="inline-flex items-center gap-1 rounded-full bg-ink/70 px-2.5 py-1 text-xs font-medium text-white">
            <PlayIcon className="h-3.5 w-3.5" aria-hidden="true" />
            動画
          </span>
        </span>
      )}
    </button>
  );
}

export default function MediaGallery({ items, googleUrl }: Props) {
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  // 再読み込みのたびに増やし、画像の要素を作り直して読み込み直す。
  const [attempt, setAttempt] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (openIndex !== null && !dialog.open) dialog.showModal();
    if (openIndex === null && dialog.open) {
      dialog.close();
      triggerRef.current?.focus();
    }
  }, [openIndex]);

  if (items.length === 0) return null;

  const fail = (index: number) => setFailed((prev) => new Set(prev).add(index));
  const open = (index: number, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setVideoFailed(false);
    setOpenIndex(index);
  };
  const move = (delta: number) => {
    setVideoFailed(false);
    setOpenIndex((current) => (current === null ? current : (current + delta + items.length) % items.length));
  };
  const current = openIndex !== null ? items[openIndex] : null;
  const currentLabel = current ? current.label?.trim() || (current.videoUrl ? "口コミの動画" : "口コミの写真") : "";

  const googleLink = googleUrl ? (
    <a
      href={googleUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-sage-dark underline underline-offset-2"
    >
      Googleで見る
      <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  ) : null;

  const shown = items.map((item, index) => ({ item, index })).filter(({ index }) => !failed.has(index));
  const failedKind = items.some((item, index) => failed.has(index) && item.videoUrl) ? "写真・動画" : "写真";

  return (
    <div className="flex flex-col gap-2">
      {items.length === 1 ? (
        shown.length === 1 && <Thumb key={attempt} item={items[0]} index={0} large onFail={() => fail(0)} onOpen={open} />
      ) : (
        shown.length > 0 && (
          <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
            {shown.map(({ item, index }) => (
              <div key={`${item.thumbnailUrl}-${index}-${attempt}`} className="snap-start">
                <Thumb item={item} index={index} large={false} onFail={() => fail(index)} onOpen={open} />
              </div>
            ))}
          </div>
        )
      )}
      {failed.size > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-ivory px-3 py-2 text-xs text-ink-muted" role="status">
          <span>{items.length > 1 && shown.length > 0 ? `${failedKind}を${failed.size}件読み込めませんでした` : `${failedKind}を読み込めませんでした`}</span>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-ink"
            onClick={() => {
              setFailed(new Set());
              setAttempt((n) => n + 1);
            }}
          >
            再読み込み
          </button>
          {googleLink}
        </div>
      )}

      <dialog
        ref={dialogRef}
        aria-label={currentLabel}
        onCancel={(e) => {
          e.preventDefault();
          setOpenIndex(null);
        }}
        onKeyDown={(e) => {
          if (items.length < 2) return;
          if (e.key === "ArrowRight") move(1);
          if (e.key === "ArrowLeft") move(-1);
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-3xl rounded-2xl border border-border bg-white p-0 text-ink backdrop:bg-ink/60"
      >
        {current && (
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm text-ink-muted">
                {currentLabel}
                {items.length > 1 ? `(${(openIndex ?? 0) + 1}/${items.length})` : ""}
              </p>
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpenIndex(null)}>
                閉じる
              </Button>
            </div>
            <div className="flex min-h-48 items-center justify-center rounded-xl bg-beige">
              {current.videoUrl ? (
                videoFailed ? (
                  <div className="flex flex-col items-center gap-2 p-6 text-center">
                    <p className="text-sm text-ink-muted">この動画はSalonPackでは再生できません。</p>
                    {googleLink}
                  </div>
                ) : (
                  <video
                    key={current.videoUrl}
                    src={current.videoUrl}
                    poster={current.thumbnailUrl}
                    controls
                    playsInline
                    className="max-h-[70dvh] w-full rounded-xl"
                    onError={() => setVideoFailed(true)}
                  />
                )
              ) : failed.has(openIndex ?? -1) ? (
                <p className="p-6 text-sm text-ink-muted">写真を読み込めませんでした</p>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- Google の画像は複製・最適化しない(GBP の保存の制限)
                <img
                  src={current.thumbnailUrl}
                  alt={currentLabel}
                  className="max-h-[70dvh] w-auto max-w-full rounded-xl object-contain"
                  referrerPolicy="no-referrer"
                  onError={() => openIndex !== null && fail(openIndex)}
                />
              )}
            </div>
            {items.length > 1 && (
              <div className="flex justify-between gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => move(-1)}>
                  <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
                  前へ
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => move(1)}>
                  次へ
                  <ChevronLeftIcon className="h-4 w-4 rotate-180" aria-hidden="true" />
                </Button>
              </div>
            )}
          </div>
        )}
      </dialog>
    </div>
  );
}
