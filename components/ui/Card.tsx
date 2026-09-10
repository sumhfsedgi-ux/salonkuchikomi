import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

// The one card shape for the whole dashboard: 16px radius, hairline border,
// no shadow (per design brief: avoid the "rounded + shadow + tinted card"
// AI-SaaS look). Previously every page hand-wrote its own padding/radius
// combination (p-4/p-5/p-6, rounded-xl/2xl) -- this is the single source of
// truth going forward for anything under /dashboard.
export default function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-2xl border border-border bg-white p-5", className)}
      {...props}
    />
  );
}
