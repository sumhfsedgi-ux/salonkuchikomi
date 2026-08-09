import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import SalonSettingsForm from "@/components/admin/SalonSettingsForm";

export default async function AdminSettingsPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/admin");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">店舗設定</h1>
        <p className="mt-1 text-sm text-slate-500">
          店舗名やGoogle口コミ投稿URLなどを編集できます。
        </p>
      </div>
      <div className="max-w-xl rounded-xl border border-slate-200 bg-white p-6">
        <SalonSettingsForm salon={salon} />
      </div>
    </div>
  );
}
