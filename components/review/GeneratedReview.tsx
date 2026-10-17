"use client";

import type { Ref } from "react";
import { reviewCharacterCount } from "@/lib/ai/naturalJapanese/evidence";

// 回答の内容(満足度・否定的な内容の有無)によって、Google口コミへの導線を出し分けては
// いけない(review gating の禁止。docs/plans/reviews-465-plan.md §7-1)。そのため、この
// コンポーネントには CTA の表示を切り替える引数を持たせない(テストで保証している)。
// copyFailed は、直前のコピーに失敗したときの手動コピーの案内を出すだけで、導線は変えない。
interface Props {
  review: string;
  onReviewChange: (next: string) => void;
  /** 「口コミをコピーして進む」。コピーできたら投稿のご案内へ進む(ReviewFlow)。 */
  onCopy: () => void;
  onRegenerate: () => void;
  googleReviewUrl: string;
  disabled?: boolean;
  /** 直前のコピーに失敗した(手動でコピーする案内と、そのまま進むボタンを出す)。 */
  copyFailed?: boolean;
  /** 手動でコピーしたあと、投稿のご案内へ進む。 */
  onManualContinue?: () => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

export default function GeneratedReview({
  review,
  onReviewChange,
  onCopy,
  onRegenerate,
  googleReviewUrl,
  disabled = false,
  copyFailed = false,
  onManualContinue,
  textareaRef,
}: Props) {
  return (
    <div
      className={[
        "flex flex-col gap-4 pb-8 animate-result-in transition-opacity",
        disabled ? "pointer-events-none opacity-60" : "",
      ].join(" ")}
    >
      <div className="text-center">
        <h2 className="text-base font-medium leading-relaxed tracking-wide text-stone-700">
          <span className="block">ご協力ありがとうございます。</span>
          <span className="inline-block">ご回答をもとに、</span>
          <span className="inline-block">口コミ文章を作成しました。</span>
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">
          よろしければ、口コミの投稿もご協力いただけますと幸いです。
        </p>
      </div>

      <div className="card">
        <p className="mb-2 text-xs leading-relaxed text-stone-500">
          内容を確認して、実際の体験と違うところがあれば自由に編集してください。
        </p>
        <textarea
          ref={textareaRef}
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

      {copyFailed && (
        <div role="alert" className="rounded-lg border border-greige bg-white p-3 text-sm leading-relaxed text-stone-700">
          <p>
            コピーできませんでした。もう一度お試しいただくか、上の文章を長押し（パソコンは選択して Ctrl+C／⌘+C）してコピーしてください。
          </p>
          <button
            type="button"
            onClick={onManualContinue}
            disabled={disabled}
            className="mt-3 w-full rounded-lg border border-sage bg-white py-2.5 text-sm font-medium text-sage-dark transition hover:bg-sage/10 disabled:opacity-50"
          >
            コピーできたので次へ進む
          </button>
        </div>
      )}

      {/* コピーだけを行い、Google は開かない(開くのは投稿のご案内の「Googleの投稿画面を開く」)。 */}
      <button type="button" onClick={onCopy} disabled={disabled} className="btn-primary">
        {copyFailed ? "もう一度コピーする" : "口コミをコピーして進む"}
      </button>
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
      {/* 文章案を使わずに投稿したい人向け。コピーはせず、Google の投稿画面をそのまま開く(通常のリンク)。 */}
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
