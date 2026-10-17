"use client";

// STEP 3 投稿のご案内。コピーのあとに同じページで出し、Google の投稿画面での操作を3つの手順で伝える。
//   ・Google は、この画面の「Googleの投稿画面を開く」を押したときだけ開く(自動では移動しない)。
//     window.open ではなく通常のリンク(<a target="_blank">)にして、スマートフォンでもポップアップの
//     制限にかかりにくくする。
//   ・Google から戻ってきても、投稿の完了としては扱わない(この画面のまま)。
//   ・回答の内容によって、表示や導線は変えない(review gating の禁止)。
interface Props {
  /** コピーできて進んだか(見出しを「口コミをコピーしました」にする)。手動でコピーして進んだときは false。 */
  copied: boolean;
  googleReviewUrl: string;
  onOpenGoogle: () => void;
  onBack: () => void;
}

const STEPS: Array<{ title: string; body?: string; note?: string }> = [
  { title: "星で評価する", body: "ご自身の体験に合った評価を選んでください。" },
  {
    title: "口コミを貼り付ける",
    body: "文章の入力欄を長押しして『貼り付け』を選んでください。",
    note: "パソコンでは、入力欄をクリックして Ctrl+V（Macは ⌘+V）で貼り付けられます。",
  },
  { title: "内容を確認して投稿する" },
];

export default function PostingGuide({ copied, googleReviewUrl, onOpenGoogle, onBack }: Props) {
  return (
    <div className="flex flex-col gap-4 pb-8 animate-result-in">
      <div className="text-center">
        {copied && (
          <span
            aria-hidden="true"
            className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-sage/15 text-sage-dark"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m5 10.5 3.2 3.2L15 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
        <h2 className="text-base font-medium leading-relaxed tracking-wide text-stone-700">
          {copied ? "口コミをコピーしました" : "投稿のご案内"}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-stone-500">
          Googleの投稿画面で、次の操作をお願いします。
        </p>
      </div>

      <ol className="card flex flex-col divide-y divide-greige/50 p-0">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3 px-4 py-4">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sage text-sm font-semibold text-white"
            >
              {i + 1}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-sm font-medium text-stone-700">
                <span className="sr-only">{`${i + 1}．`}</span>
                {step.title}
              </p>
              {step.body && <p className="mt-1 text-[13px] leading-relaxed text-stone-600">{step.body}</p>}
              {step.note && <p className="mt-1 text-xs leading-relaxed text-stone-500">{step.note}</p>}
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-2">
        <a
          href={googleReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onOpenGoogle}
          className="btn-primary block px-3 text-center"
        >
          Googleの投稿画面を開く
        </a>
        <p className="text-center text-xs text-stone-400">Googleアカウントへのログインが必要な場合があります。</p>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="w-full rounded-lg border border-sage py-3 text-sm font-medium text-sage-dark transition hover:bg-sage/10"
      >
        文章を編集する
      </button>
    </div>
  );
}
