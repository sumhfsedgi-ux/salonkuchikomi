import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getPlanExperience, listUsableFeatureKeys } from "@/lib/features/access";
import { loadFeatureAccessInput } from "@/lib/features/accessInput";
import { isOperatorUser } from "@/lib/ops/operator";
import DashboardShell from "@/components/layout/DashboardShell";
import { SERVICE_NAME } from "@/lib/brand";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");

  const salon = await getCurrentSalon(supabase);
  // サロンを持たない運営の管理者は、店舗登録・初期設定へ進めず、運営管理へ移す(通常のログインのあとの入口)。
  // 管理者かどうかは、サロンが無いときだけ確かめる(一般のオーナーには問い合わせを増やさない)。
  if (!salon && (await isOperatorUser(user.id))) redirect("/ops/salons");

  // 店舗がまだ無い(初期設定の前)は、新規店舗と同じ口コミプランとして扱う(使える機能はまだ無い)。
  const plan = salon?.plan ?? "reviews";
  const usableFeatures = salon ? listUsableFeatureKeys(await loadFeatureAccessInput(salon)) : [];

  return (
    <DashboardShell salonName={salon?.name ?? SERVICE_NAME} experience={getPlanExperience(plan)} usableFeatures={usableFeatures}>
      {children}
    </DashboardShell>
  );
}
