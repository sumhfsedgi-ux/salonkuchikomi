import { Fragment } from "react";

const STEPS = ["アンケート", "口コミ文章案"] as const;

export type ReviewStep = 1 | 2;

export default function StepIndicator({ current }: { current: ReviewStep }) {
  return (
    <ol className="flex items-start justify-center gap-3 pt-5" aria-label="進み具合">
      {STEPS.map((label, i) => {
        const step = i + 1;
        const active = step === current;
        return (
          <Fragment key={label}>
            {i > 0 && (
              <li aria-hidden="true" className="pt-3.5 text-[10px] text-greige">
                ▶
              </li>
            )}
            <li
              aria-current={active ? "step" : undefined}
              className="flex flex-col items-center gap-1"
            >
              <span
                className={[
                  "flex h-11 w-11 flex-col items-center justify-center rounded-full text-[9px] font-semibold leading-none",
                  active ? "bg-sage text-white" : "bg-beige text-stone-400",
                ].join(" ")}
              >
                STEP
                <span className="mt-0.5 text-base">{step}</span>
              </span>
              <span className={["text-[10px]", active ? "text-sage-dark" : "text-stone-400"].join(" ")}>
                {label}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
