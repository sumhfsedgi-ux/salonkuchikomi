import { Fragment } from "react";

const STEPS = [
  { step: 1, label: "回答" },
  { step: 2, label: "文章の確認" },
  { step: 3, label: "投稿のご案内" },
] as const;

export type ReviewStep = (typeof STEPS)[number]["step"];

// 今のステップと、終わったステップは緑で塗る。丸の下に短い名前を出し、丸と丸の間は細い線でつなぐ。
// 3つ並べても、スマートフォン(幅 320px〜)で横にはみ出さない幅にする。
export default function StepIndicator({ current }: { current: ReviewStep }) {
  return (
    <ol className="flex items-start justify-center" aria-label="進み具合">
      {STEPS.map(({ step, label }, i) => {
        const reached = step <= current;
        return (
          <Fragment key={step}>
            {i > 0 && (
              <li aria-hidden="true" className="flex pt-[17px]">
                <span className={["block h-px w-5 sm:w-8", reached ? "bg-sage" : "bg-greige"].join(" ")} />
              </li>
            )}
            <li
              aria-current={step === current ? "step" : undefined}
              aria-label={`STEP ${step} ${label}`}
              className="flex w-[5.5rem] flex-col items-center gap-1.5"
            >
              <span
                aria-hidden="true"
                className={[
                  "flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold leading-none",
                  reached ? "border-sage bg-sage text-white" : "border-greige bg-white text-stone-400",
                ].join(" ")}
              >
                {step}
              </span>
              <span
                aria-hidden="true"
                className={[
                  "text-[11px] leading-tight tracking-wide whitespace-nowrap",
                  step === current ? "font-medium text-sage-dark" : reached ? "text-sage-dark" : "text-stone-400",
                ].join(" ")}
              >
                {label}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
