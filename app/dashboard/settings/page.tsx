import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { featureAccessInputFor, getPlanExperience, isFeatureIntroduced, resolveAllFeatureAccess } from "@/lib/features/access";
import SalonSettingsForm from "@/components/admin/SalonSettingsForm";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";

export default async function DashboardSettingsPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  // Google連携の案内は、その店舗に紹介してよい機能(lib/features/access.ts)のうち、Google が必要なものだけ。
  // 口コミプランでは、提供中でない機能・契約外の機能を案内しない。
  const experience = getPlanExperience(salon.plan);
  const googleLabels = resolveAllFeatureAccess(featureAccessInputFor(salon))
    .filter((a) => a.definition.googleFeature && isFeatureIntroduced(a, experience, "guide"))
    .map((a) => a.definition.label);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="サロン設定" description="店舗の基本情報を編集できます。" />
      <Card className="max-w-xl">
        <SalonSettingsForm salon={salon} />
      </Card>

      {googleLabels.length > 0 && (
        <p className="text-sm text-ink-muted">
          {googleLabels.join("・")}のGoogleアカウントは
          <Link href="/dashboard/settings/google" className="text-sage-dark underline underline-offset-2">
            Google連携
          </Link>
          で管理できます。
        </p>
      )}
      <p className="text-sm text-ink-muted">
        Google口コミ投稿先の設定は
        <Link href="/dashboard/reviews" className="text-sage-dark underline underline-offset-2">
          口コミ
        </Link>
        から変更できます。
      </p>
    </div>
  );
}
