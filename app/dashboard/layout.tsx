import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { featureAccessInputFor, getPlanExperience, listUsableFeatureKeys } from "@/lib/features/access";
import DashboardShell from "@/components/layout/DashboardShell";
import { SERVICE_NAME } from "@/lib/brand";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");

  const salon = await getCurrentSalon(supabase);
  // 店舗がまだ無い(初期設定の前)は、新規店舗と同じ口コミプランとして扱う。
  const plan = salon?.plan ?? "reviews";

  return (
    <DashboardShell
      salonName={salon?.name ?? SERVICE_NAME}
      experience={getPlanExperience(plan)}
      usableFeatures={listUsableFeatureKeys(featureAccessInputFor({ plan }))}
    >
      {children}
    </DashboardShell>
  );
}
