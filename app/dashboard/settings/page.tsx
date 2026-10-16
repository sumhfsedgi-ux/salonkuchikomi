import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getPlanExperience, isFeatureIntroduced, resolveAllFeatureAccess } from "@/lib/features/access";
import { loadFeatureAccessInput } from "@/lib/features/accessInput";
import SalonSettingsForm from "@/components/admin/SalonSettingsForm";
import SalonProfileForm from "@/components/onboarding/SalonProfileForm";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";

export default async function DashboardSettingsPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");
  const user = await getAuthedUser(supabase);

  // Google連携の案内は、その店舗に紹介してよい機能(lib/features/access.ts)のうち、Google が必要なものだけ。
  // 口コミプランでは、提供中でない機能・契約外の機能を案内しない。
  const experience = getPlanExperience(salon.plan);
  const googleLabels = resolveAllFeatureAccess(await loadFeatureAccessInput(salon))
    .filter((a) => a.definition.googleFeature && isFeatureIntroduced(a, experience, "guide"))
    .map((a) => a.definition.label);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="サロン設定" description="店舗の基本情報を編集できます。" />
      <Card className="max-w-xl">
        <SalonSettingsForm salon={salon} />
      </Card>

      <Card className="flex max-w-xl flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink">ご登録内容(担当者・連絡先)</h2>
          <p className="mt-1 text-sm text-ink-muted">運営からのご連絡に使います。お客様用ページには表示されません。</p>
        </div>
        <SalonProfileForm
          mode="edit"
          loginEmail={user?.email ?? ""}
          initial={{
            name: salon.name,
            contactName: salon.contactName ?? "",
            businessType: salon.businessType ?? "",
            contactEmailMode: salon.contactEmail ? "other" : "same",
            contactEmail: salon.contactEmail ?? "",
            contactPhone: salon.contactPhone ?? "",
          }}
        />
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
