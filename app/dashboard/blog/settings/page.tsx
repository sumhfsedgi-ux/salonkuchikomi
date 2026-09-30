import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFeatureAccess } from "@/lib/access/featureAccess";
import { getSalonSettings } from "@/lib/blog/queries";
import PageHeader from "@/components/ui/PageHeader";
import BlogSubNav from "@/components/blog/BlogSubNav";
import Card from "@/components/ui/Card";
import SalonSettingsForm from "@/components/blog/settings/SalonSettingsForm";

// 保存直後の内容を必ず反映する必要があるため、ビルド時の静的プリレンダリングは行わない。
export const dynamic = "force-dynamic";

export default async function DashboardBlogSettingsPage() {
  const supabase = await createClient();
  const salon = await requireFeatureAccess(supabase, "blog");

  const settings = await getSalonSettings(salon.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="ブログ設定" description="ここで入力した内容をもとに、ブログの内容が作られます。" />
      <BlogSubNav />

      <p className="text-sm text-ink-muted">
        店舗名・業種は
        <Link href="/dashboard/settings" className="text-sage-dark underline underline-offset-2">
          サロン設定
        </Link>
        で管理しています。
      </p>

      <SalonSettingsForm initialSettings={settings} />

      <Link
        href="/dashboard/blog/settings/style-profile"
        className="block transition hover:opacity-90"
      >
        <Card className="flex flex-col gap-1">
          <p className="font-medium text-ink">文体を学習する</p>
          <p className="text-sm text-ink-muted">
            過去のブログを取り込み、このサロンらしい文体でブログが生成されるようにします。
          </p>
        </Card>
      </Link>
    </div>
  );
}
