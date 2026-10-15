import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// 空・準備中・見つからないなどの状態の表示(docs/plans/google-reviews-inbox-plan.md §8-6・§8-7)。
// Card の中に置く前提で、見出し・説明・ボタン1〜2個だけにする(ComingSoon と同じ温度感)。
interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function EmptyState({ title, description, actions, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-start gap-2 py-2", className)}>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <div className="text-sm text-ink-muted">{description}</div>}
      {actions && <div className="mt-1 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
