import { Fragment } from "react";

const STEPS = [1, 2] as const;

export type ReviewStep = (typeof STEPS)[number];

// 今のステップと、終わったステップは緑で塗る。丸と丸の間は小さい三角でつなぐ。
export default function StepIndicator({ current }: { current: ReviewStep }) {
  return (
    <ol className="flex items-center justify-center gap-4 pt-5" aria-label="進み具合">
      {STEPS.map((step, i) => {
        const reached = step <= current;
        return (
          <Fragment key={step}>
            {i > 0 && (
              <li aria-hidden="true" className="flex">
                <svg
                  viewBox="0 0 6 8"
                  className={["h-2.5 w-2", reached ? "fill-sage" : "fill-stone-400"].join(" ")}
                >
                  <path d="M0 0 6 4 0 8Z" />
                </svg>
              </li>
            )}
            <li aria-current={step === current ? "step" : undefined} aria-label={`STEP ${step}`}>
              <span
                className={[
                  "flex h-12 w-12 flex-col items-center justify-center rounded-full border leading-none",
                  reached
                    ? "border-sage bg-sage text-white"
                    : "border-greige bg-white text-stone-400",
                ].join(" ")}
              >
                <span className="text-[8px] font-semibold tracking-widest">STEP</span>
                <span className="mt-0.5 text-lg font-semibold">{step}</span>
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
