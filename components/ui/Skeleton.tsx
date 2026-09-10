import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export default function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-lg bg-beige", className)} aria-hidden="true" {...props} />;
}
