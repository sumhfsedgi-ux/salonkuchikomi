"use client";

interface Props {
  review: string;
  onReviewChange: (next: string) => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onEditSurvey: () => void;
  error: string | null;
}

export default function GeneratedReview({
  review,
  onReviewChange,
  onCopy,
  onRegenerate,
  onEditSurvey,
  error,
}: Props) {
  return (
    <div className="flex flex-col gap-4 pb-8">
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
          className="w-full resize-none rounded-lg border border-greige bg-white p-3 text-sm leading-relaxed text-stone-700 focus:border-sage focus:outline-none"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <button type="button" className="btn-primary" onClick={onCopy}>
        口コミをコピーする
      </button>
      <div className="flex items-center justify-center gap-4">
        <button type="button" className="btn-text" onClick={onRegenerate}>
          もう一度作成する
        </button>
        <span className="text-greige">|</span>
        <button type="button" className="btn-text" onClick={onEditSurvey}>
          アンケートを修正する
        </button>
      </div>
    </div>
  );
}
