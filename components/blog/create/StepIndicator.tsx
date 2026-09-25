interface Props {
  step: 1 | 2 | 3;
}

const STEPS = [
  { n: 1, label: "作成" },
  { n: 2, label: "確認" },
  { n: 3, label: "コピー" },
] as const;

export default function StepIndicator({ step }: Props) {
  return (
    <div className="mb-6">
      <div className="flex justify-between text-xs">
        {STEPS.map((s) => (
          <span key={s.n} className={s.n === step ? "font-medium text-sage-dark" : "text-ink-muted/60"}>
            STEP {s.n} {s.label}
          </span>
        ))}
      </div>
      <div className="mt-2 h-1 rounded-full bg-beige">
        <div className="h-1 rounded-full bg-sage transition-all" style={{ width: `${(step / 3) * 100}%` }} />
      </div>
    </div>
  );
}
