import Link from "next/link";
import type { ComponentType, ReactNode, SVGProps } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

interface FeatureCardProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  status: "active" | "coming-soon";
  href: string;
  ctaLabel: string;
  /** e.g. a compact "URLをコピー" link shown next to the primary CTA. */
  secondaryAction?: ReactNode;
}

// The one card shape for every entry point on the Home screen -- 口コミ,
// ブログ, 予約通知 all render through this so the "3 systems glued
// together" look never has a chance to happen: same icon treatment, same
// title/description hierarchy, same CTA placement, whether the section is
// live today or still "準備中".
export default function FeatureCard({
  icon: Icon,
  title,
  description,
  status,
  href,
  ctaLabel,
  secondaryAction,
}: FeatureCardProps) {
  const isActive = status === "active";

  return (
    // self-start on non-active cards: without it, CSS Grid's default
    // align-items: stretch would still force these to match the tallest
    // (active) card's height once they stop rendering a CTA row below --
    // leaving a blank gap instead of actually reading as more compact.
    <Card className={cn("flex flex-col gap-4", !isActive && "self-start")}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            isActive ? "bg-sage-soft text-sage-dark" : "bg-beige text-ink-muted",
          )}
          aria-hidden="true"
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink sm:text-lg">{title}</h2>
            {!isActive && <Badge variant="neutral">準備中</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        </div>
      </div>

      {/* Coming-soon features intentionally show no CTA -- a button here
          would promise an action the feature can't actually perform yet.
          status/href/ctaLabel stay in the props shape unchanged so
          flipping status to "active" later is the only change needed to
          bring the CTA back. */}
      {isActive && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href={href} className={buttonClassName({ variant: "primary", size: "sm" })}>
            {ctaLabel}
          </Link>
          {secondaryAction}
        </div>
      )}
    </Card>
  );
}
