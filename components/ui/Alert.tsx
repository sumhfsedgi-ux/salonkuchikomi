import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type AlertVariant = "error" | "success" | "warning";

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error: "border-red-200 bg-danger-soft text-danger",
  success: "border-sage/30 bg-sage-soft text-sage-dark",
  warning: "border-warning/30 bg-warning-soft text-warning",
};

interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
}

// The one inline error/success message box for every form in the app.
// Replaces the near-identical `rounded-lg border ... p-3 text-sm ...` div
// that used to be hand-copied into every form component.
export default function Alert({ variant = "error", className, ...props }: AlertProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn("rounded-lg border p-3 text-sm", VARIANT_CLASSES[variant], className)}
      {...props}
    />
  );
}
