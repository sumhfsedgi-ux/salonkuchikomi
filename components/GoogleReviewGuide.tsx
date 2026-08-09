const steps = [
  "Google口コミページを開く",
  "ご自身の評価を選択する",
  "コピーした口コミを貼り付ける",
  "内容を確認して投稿する",
];

export default function GoogleReviewGuide() {
  const googleReviewUrl = process.env.NEXT_PUBLIC_GOOGLE_REVIEW_URL ?? "";

  return (
    <div className="flex flex-col gap-4 pb-8">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-stone-800">
          口コミをコピーしました
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-500">
          最後にGoogleの口コミページで
          <br />
          コピーした文章を貼り付けて投稿してください。
        </p>
      </div>

      <div className="card">
        <ol className="flex flex-col gap-3">
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-3 text-sm text-stone-600">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sage/15 text-xs font-medium text-sage-dark">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>

      <a
        href={googleReviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-primary block text-center"
      >
        Google口コミページを開く
      </a>
    </div>
  );
}
