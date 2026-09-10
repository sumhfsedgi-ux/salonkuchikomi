import type { LabelHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export default function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1 block text-sm font-medium text-ink", className)} {...props} />;
}
