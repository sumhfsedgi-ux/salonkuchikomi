import { redirect } from "next/navigation";
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
      <PageHeader title="サロン設定" description="店舗名やGoogle口コミ投稿URLなどを編集できます。" />
      <Card className="max-w-xl">
        <SalonSettingsForm salon={salon} />
      </Card>
    </div>
  );
}
