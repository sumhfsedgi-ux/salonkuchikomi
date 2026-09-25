import { SERVICE_NAME } from "@/lib/brand";
import { cn } from "@/lib/cn";

// A simple monogram-in-a-square stand-in for a real logo asset (none exists
// yet -- see lib/brand.ts). Swapping this for a real mark later only means
// replacing this one component.
export default function Logo({
  className,
  markOnly = false,
}: {
  className?: string;
  markOnly?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sage text-sm font-semibold text-white"
        aria-hidden="true"
      >
        {SERVICE_NAME.charAt(0)}
      </span>
      {!markOnly && <span className="text-base font-semibold text-ink">{SERVICE_NAME}</span>}
    </span>
  );
}
