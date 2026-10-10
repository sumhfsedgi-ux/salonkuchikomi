import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { loadSetupContext } from "@/lib/features/setupContext";
import { resolveFeatureStates } from "@/lib/features/featureState";
import { toFeatureOptions } from "@/lib/features/viewModel";
import SalonSettingsForm from "@/components/admin/SalonSettingsForm";
import FeatureSelectionForm from "@/components/features/FeatureSelectionForm";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";

export default async function DashboardSettingsPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  const ctx = await loadSetupContext(salon);
  const { states } = resolveFeatureStates(ctx);
  const usesGoogle = states.some((s) => s.definition.googleFeature && (s.selected || s.status === "coming_soon"));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="サロン設定" description="店舗の基本情報を編集できます。" />
      <Card className="max-w-xl">
        <SalonSettingsForm salon={salon} />
      </Card>

      <section id="features" className="flex max-w-xl flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">利用する機能</h2>
        <Card>
          <FeatureSelectionForm options={toFeatureOptions(states)} submitLabel="保存する" />
        </Card>
      </section>

      {usesGoogle && (
        <p className="text-sm text-ink-muted">
          予約通知・届いた口コミのGoogleアカウントは
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
