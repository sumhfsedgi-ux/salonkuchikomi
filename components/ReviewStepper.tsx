type Step = 1 | 2 | 3;

const steps: { step: Step; label: string }[] = [
  { step: 1, label: "アンケート" },
  { step: 2, label: "口コミ作成" },
  { step: 3, label: "Google投稿" },
];

export default function ReviewStepper({ currentStep }: { currentStep: Step }) {
  return (
    <div className="flex items-center justify-between gap-2 py-4">
      {steps.map(({ step, label }, index) => {
        const isCurrent = step === currentStep;
        const isDone = step < currentStep;
        return (
          <div key={step} className="flex flex-1 items-center">
            <div className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className={[
                  "flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition",
                  isCurrent
                    ? "bg-sage text-white"
                    : isDone
                      ? "bg-sage/30 text-sage-dark"
                      : "bg-beige text-stone-400",
                ].join(" ")}
              >
                {isDone ? (
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  step
                )}
              </div>
              <span
                className={[
                  "text-[11px] leading-tight text-center",
                  isCurrent ? "font-medium text-stone-800" : "text-stone-400",
                ].join(" ")}
              >
                STEP{step}
                <br />
                {label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={[
                  "mb-5 h-px flex-1",
                  isDone ? "bg-sage/40" : "bg-greige",
                ].join(" ")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
