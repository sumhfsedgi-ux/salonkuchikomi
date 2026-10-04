"use client";

// 回答の内容(満足度・否定的な内容の有無)によって、Google口コミへの導線を出し分けては
// いけない(review gating の禁止。docs/plans/reviews-465-plan.md §7-1)。そのため、この
// コンポーネントには CTA の表示を切り替える引数を持たせない(テストで保証している)。
interface Props {
  review: string;
  onReviewChange: (next: string) => void;
  onCopy: () => void;
  googleReviewUrl: string;
  disabled?: boolean;
}

export default function GeneratedReview({
  review,
  onReviewChange,
  onCopy,
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
        <h2 className="text-lg font-semibold text-stone-800">
          口コミの下書きができました
        </h2>
        <p className="mt-2 text-balance text-sm text-stone-500">
          アンケートをもとに口コミ文を作成しました。
          <br />
          内容を確認して、必要に応じて自由に編集してください。
        </p>
      </div>

      <div className="card">
        <textarea
          value={review}
          onChange={(e) => onReviewChange(e.target.value)}
          rows={8}
          disabled={disabled}
          className="w-full resize-none rounded-lg border border-greige bg-white p-3 text-sm leading-relaxed text-stone-700 focus:border-sage focus:outline-none"
        />
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
        className="btn-primary block text-center"
      >
        この内容をコピーしてGoogleへ進む
      </a>
      <p className="text-center text-xs text-stone-400">
        Googleの口コミ投稿画面が開きます。
        <br />
        自動で投稿されることはありません。
      </p>
    </div>
  );
}
