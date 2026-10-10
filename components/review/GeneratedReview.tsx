"use client";

import { reviewCharacterCount } from "@/lib/ai/naturalJapanese/evidence";

// 回答の内容(満足度・否定的な内容の有無)によって、Google口コミへの導線を出し分けては
// いけない(review gating の禁止。docs/plans/reviews-465-plan.md §7-1)。そのため、この
// コンポーネントには CTA の表示を切り替える引数を持たせない(テストで保証している)。
interface Props {
  review: string;
  onReviewChange: (next: string) => void;
  onCopy: () => void;
  onRegenerate: () => void;
  googleReviewUrl: string;
  disabled?: boolean;
}

export default function GeneratedReview({
  review,
  onReviewChange,
  onCopy,
  onRegenerate,
  googleReviewUrl,
  disabled = false,
}: Props) {
  return (
    <div
      className={[
        "flex flex-col gap-4 pb-8 animate-result-in transition-opacity",
        disabled ? "pointer-events-none opacity-60" : "",
      ].join(" ")}
    >
      <div className="text-center">
        <h2 className="text-lg font-semibold leading-snug text-stone-800">
          <span className="inline-block">アンケートの回答をもとに</span>
          <span className="inline-block">口コミの文章案を作成しました</span>
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-500">
          ご回答ありがとうございます。よろしければ、ぜひ口コミの投稿にご協力いただけますと幸いです。
        </p>
      </div>

      <div className="card">
        <p className="mb-2 text-xs leading-relaxed text-stone-500">
          内容を確認して、実際の体験と違うところがあれば自由に編集してください。
        </p>
        <textarea
          aria-label="口コミの下書き"
          value={review}
          onChange={(e) => onReviewChange(e.target.value)}
          rows={8}
          disabled={disabled}
          className="w-full resize-none rounded-lg border border-greige bg-white p-3 text-sm leading-relaxed text-stone-700 focus:border-sage focus:outline-none"
        />
        <p className="mt-2 text-right text-xs text-stone-500" aria-live="polite">
          {reviewCharacterCount(review)}文字（改行を除く）
        </p>
      </div>

      {/*
        A real <a target="_blank"> whose default action is never prevented,
        not a scripted window.open(). That default action is the browser's
        own "open this link in a new tab" behavior tied directly to the
        trusted click event, so it isn't subject to popup-blocker heuristics
        the way a window.open() called after an `await` would be -- this is
        what keeps iOS Safari from silently blocking the Google tab. onCopy
        is async and intentionally not awaited here: the copy attempt runs
        alongside the navigation rather than gating it, so a slow or failed
        Clipboard API call never delays or blocks getting to Google's page.
      */}
      <a
        href={googleReviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onCopy}
        className="btn-primary block px-3 text-center"
      >
        {/* 狭い画面では「コピーして」のあとで折り返す(最後の1文字だけが次の行に回らないように)。 */}
        <span className="inline-block">この口コミをコピーして</span>
        <span className="inline-block">Googleレビューへ進む</span>
      </a>
      <p className="-mt-2 text-center text-xs text-stone-400">
        自動で投稿されることはありません
      </p>

      <button
        type="button"
        onClick={onRegenerate}
        disabled={disabled}
        className="w-full rounded-lg border border-sage py-3 text-sm font-medium text-sage-dark transition hover:bg-sage/10 disabled:opacity-50"
      >
        もう一度作成する
      </button>
      {/* 文章案を使わずに投稿したい人向け。コピーはせず、同じ Google の投稿画面を開く。 */}
      <a
        href={googleReviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block py-1 text-center text-sm text-sage-dark underline underline-offset-4"
      >
        自分で文章を考えて投稿する
      </a>
    </div>
  );
}
