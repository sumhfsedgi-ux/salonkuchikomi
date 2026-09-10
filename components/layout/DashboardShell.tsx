import type { ReactNode } from "react";
import Sidebar from "@/components/layout/Sidebar";
import BottomNav from "@/components/layout/BottomNav";
import MobileHeader from "@/components/layout/MobileHeader";

// The one layout shell for every /dashboard/** page: PC sidebar + centered
// content on the left/right split, mobile header + bottom nav + centered
// content stacked. main's max-w-5xl keeps content from stretching edge to
// edge on wide monitors (per "コンテンツが横に広がりすぎないよう適切な
// max-widthを使用").
export default function DashboardShell({
  salonName,
  children,
}: {
  salonName: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-ivory">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader salonName={salonName} />
        {/* pb-24 leaves clearance above the fixed BottomNav on mobile; md:pb
            drops back down since BottomNav is hidden from md up. */}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8 md:pt-6">
          {children}
        </main>
        <BottomNav />
      </div>
    </div>
  );
}
