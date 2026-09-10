import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "sm";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-sage text-white hover:bg-sage-dark",
  secondary: "bg-white text-ink border border-border hover:bg-ivory",
  ghost: "text-ink-muted hover:bg-sage-soft hover:text-sage-dark",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "px-5 py-2.5 text-sm",
  sm: "px-3.5 py-2 text-sm",
};

// Shared with any element that should look like a Button but can't be one
// (e.g. a Next.js <Link> used as a call-to-action) -- see FeatureCard.
export function buttonClassName({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}): string {
  return cn(
    // min-h-11 (44px) keeps every button/link styled this way at or above
    // the minimum comfortable tap target size.
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg font-medium transition disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 focus-visible:ring-offset-2 focus-visible:ring-offset-ivory",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth && "w-full",
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, fullWidth, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={buttonClassName({ variant, size, fullWidth, className })}
      {...props}
    />
  );
});

export default Button;
