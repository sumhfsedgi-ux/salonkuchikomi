import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

// The one page-title treatment for every /dashboard/** page: 24px on
// mobile, 30px from sm up (per the 22-26px mobile / 28-32px desktop spec).
export default function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-ink sm:text-3xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-muted sm:text-base">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
