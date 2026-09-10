import Logo from "@/components/ui/Logo";
import ProfileMenu from "@/components/layout/ProfileMenu";

export default function MobileHeader({ salonName }: { salonName: string }) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-white/95 px-4 py-3 backdrop-blur md:hidden">
      <Logo markOnly />
      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{salonName}</p>
      <ProfileMenu />
    </header>
  );
}
