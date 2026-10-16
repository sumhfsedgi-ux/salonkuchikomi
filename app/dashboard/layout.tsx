import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getPlanExperience, listUsableFeatureKeys } from "@/lib/features/access";
import { loadFeatureAccessInput } from "@/lib/features/accessInput";
import { getAccountState } from "@/lib/onboarding/accountState";
import { resolveNextStep } from "@/lib/onboarding/nextStep";
import DashboardShell from "@/components/layout/DashboardShell";

// 店舗の画面の入口。ログイン → 本人確認 → 店舗の登録 → 利用開始 のうち、済んでいない段階へ移す(lib/onboarding/nextStep.ts)。
//   - 運営の管理者は /ops(店舗の登録・初期設定には進まない)
//   - 本人確認が済んでいない・本人確認より前のセッション(信頼できない)は /auth/verify
//   - 店舗が無ければ /onboarding/salon、利用開始待ちなら /onboarding/status
// Server Action・API は layout を通らないため、それぞれの入口でも同じ判定(getCurrentSalon・DB の利用可否)を通る。
export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");

  const account = await getAccountState(supabase);
  const salon = account?.sessionTrusted ? await getCurrentSalon(supabase) : null;
  const next = resolveNextStep({ account, salon });
  if (next !== "/dashboard" || !salon) redirect(next);

  const usableFeatures = listUsableFeatureKeys(await loadFeatureAccessInput(salon));

  return (
    <DashboardShell salonName={salon.name} experience={getPlanExperience(salon.plan)} usableFeatures={usableFeatures}>
      {children}
    </DashboardShell>
  );
}
