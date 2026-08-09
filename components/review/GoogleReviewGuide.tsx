const steps = [
  "Google口コミページを開く",
  "ご自身の評価を選択する",
  "コピーした口コミを貼り付ける",
  "内容を確認して投稿する",
];

// Intentionally takes no props derived from survey answers — every visitor
// sees this exact same screen regardless of how they answered, so the
// Google review CTA can never be gated on sentiment.
export default function GoogleReviewGuide({
  googleReviewUrl,
}: {
  googleReviewUrl: string;
}) {
  return (
    <div className="flex flex-col gap-4 pb-8">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-stone-800">
          口コミをコピーしました
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-500">
          <span className="block">最後にGoogleの口コミページで</span>
          <span className="block text-balance">
            コピーした文章を貼り付けて投稿してください。
          </span>
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
