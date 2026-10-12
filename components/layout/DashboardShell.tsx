import type { ReactNode } from "react";
import Sidebar from "@/components/layout/Sidebar";
import BottomNav from "@/components/layout/BottomNav";
import MobileHeader from "@/components/layout/MobileHeader";
import type { PlanExperience } from "@/lib/features/access";
import type { FeatureKey } from "@/lib/features/registry";

// The one layout shell for every /dashboard/** page: PC sidebar + centered
// content on the left/right split, mobile header + bottom nav + centered
// content stacked. main's max-w-5xl keeps content from stretching edge to
// edge on wide monitors (per "コンテンツが横に広がりすぎないよう適切な
// max-widthを使用").
// experience(契約プランごとの画面の作り)と usableFeatures(利用できる機能)は、
// app/dashboard/layout.tsx がサーバーで判定して渡す(PC とスマホのメニューで同じ値を使う)。
export default function DashboardShell({
  salonName,
  experience,
  usableFeatures,
  children,
}: {
  salonName: string;
  experience: PlanExperience;
  usableFeatures: FeatureKey[];
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-ivory">
      <Sidebar experience={experience} usableFeatures={usableFeatures} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader salonName={salonName} experience={experience} />
        {/* pb-24 leaves clearance above the fixed BottomNav on mobile; md:pb
            drops back down since BottomNav is hidden from md up. */}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8 md:pt-6">
          {children}
        </main>
        <BottomNav experience={experience} usableFeatures={usableFeatures} />
      </div>
    </div>
  );
}
