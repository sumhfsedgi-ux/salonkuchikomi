"use client";

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
          口コミが完成しました
        </h2>
        <p className="mt-2 text-balance text-sm text-stone-500">
          内容を確認して、必要であれば自由に修正してください。
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

      <button type="button" className="btn-primary" onClick={onCopy}>
        口コミをコピーする
      </button>
      <a
        href={googleReviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-secondary block text-center"
      >
        Google口コミページを開く
      </a>
      <p className="text-center text-xs text-stone-400">
        投稿前に内容をご確認ください
      </p>
    </div>
  );
}
