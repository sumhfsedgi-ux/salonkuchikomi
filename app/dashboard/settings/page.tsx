import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import SalonSettingsForm from "@/components/admin/SalonSettingsForm";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";

export default async function DashboardSettingsPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="サロン設定" description="店舗の基本情報を編集できます。" />
      <Card className="max-w-xl">
        <SalonSettingsForm salon={salon} />
      </Card>
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
