import Link from "next/link";
import { type ComponentType, type ReactNode, type SVGProps } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { HomeCard } from "@/lib/features/homeCards";

interface FeatureCardProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  card: HomeCard;
  /** e.g. a compact "URLをコピー" link shown next to the primary CTA. */
  secondaryAction?: ReactNode;
}

// The one card shape for every entry point on the Home screen -- 口コミ,
// ブログ, 予約通知 all render through this so the "3 systems glued
// together" look never has a chance to happen: same icon treatment, same
// title/description hierarchy, same CTA placement.
//
// 使えない機能(契約外・準備中)も紹介するため、説明は読める濃さのまま残し、カードをグレーにして
// ボタンを非活性にする。色だけで区別しないよう、どのカードにも文字のバッジと理由を付け、
// 非活性のボタンは理由の文と aria-describedby でつなぐ(lib/features/homeCards.ts)。
export default function FeatureCard({ icon: Icon, card, secondaryAction }: FeatureCardProps) {
  const reasonId = `feature-${card.key}-reason`;
  const muted = card.kind === "not_allowed" || card.kind === "coming_soon" || card.kind === "suspended";

  return (
    <Card tone={muted ? "muted" : "default"} className="flex flex-col gap-4" data-feature={card.key} data-kind={card.kind}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            muted ? "bg-beige text-ink-muted" : "bg-sage-soft text-sage-dark",
          )}
          aria-hidden="true"
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={cn("text-base font-semibold sm:text-lg", muted ? "text-ink-muted" : "text-ink")}>{card.title}</h2>
            {card.badge && (
              <Badge variant={card.badge.variant} dot={card.kind === "available"}>
                {card.badge.label}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-muted">{card.description}</p>
          {card.reason && (
            <p id={reasonId} className={cn("mt-2 whitespace-pre-line text-xs", card.kind === "setup_required" ? "text-warning" : "text-ink-muted")}>
              {card.reason}
            </p>
          )}
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2">
        {card.href ? (
          <Link href={card.href} className={buttonClassName({ variant: "primary", size: "sm" })}>
            {card.ctaLabel}
          </Link>
        ) : (
          <button
            type="button"
            disabled
            aria-describedby={card.reason ? reasonId : undefined}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
          >
            {card.ctaLabel}
          </button>
        )}
        {secondaryAction}
      </div>
    </Card>
  );
}
