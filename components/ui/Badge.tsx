import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant = "neutral" | "success" | "warning" | "danger";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  // "準備中" and other neutral labels.
  neutral: "bg-beige text-ink-muted",
  // "通知中" / "接続済み" -- the only place outside primary CTAs that sage
  // is allowed to appear, per the design brief's "accent used sparingly" rule.
  success: "bg-sage-soft text-sage-dark",
  // "Gmailの再接続が必要です" and similar attention-needed states.
  warning: "bg-warning-soft text-warning",
  // 「公開できませんでした」など、対応が必要なエラーの状態(Alert の error と同じ色)。
  danger: "bg-danger-soft text-danger",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Shows a small leading dot (e.g. "● 通知中") instead of/alongside an icon. */
  dot?: boolean;
}

export default function Badge({ variant = "neutral", dot, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
