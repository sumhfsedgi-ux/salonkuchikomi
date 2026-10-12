import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

// The one card shape for the whole dashboard: 16px radius, hairline border,
// no shadow (per design brief: avoid the "rounded + shadow + tinted card"
// AI-SaaS look). Previously every page hand-wrote its own padding/radius
// combination (p-4/p-5/p-6, rounded-xl/2xl) -- this is the single source of
// truth going forward for anything under /dashboard.
// tone="muted" は、使えない機能などを読める濃さのままグレーで示すとき(背景色の上書きを className で
// 重ねると、どちらが効くかが CSS の出力順で決まってしまうため、ここで切り替える)。
export default function Card({ className, tone = "default", ...props }: HTMLAttributes<HTMLDivElement> & { tone?: "default" | "muted" }) {
  return (
    <div
      className={cn("rounded-2xl border border-border p-5", tone === "muted" ? "bg-beige/50" : "bg-white", className)}
      {...props}
    />
  );
}
