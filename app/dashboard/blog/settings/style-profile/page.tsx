import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { getSalonSettings, listReferencePosts, getStyleProfile } from "@/lib/blog/queries";
import PageHeader from "@/components/ui/PageHeader";
import HotPepperImportPanel from "@/components/blog/settings/HotPepperImportPanel";
import ReferencePostList from "@/components/blog/settings/ReferencePostList";
import StyleProfilePanel from "@/components/blog/settings/StyleProfilePanel";

// Server Actionsのタイムアウトはページ側のmaxDurationで決まる仕様のため、ここで指定する
// （Hot Pepperの取り込みは複数ページ・複数記事を直列取得するため既定の実行時間では不足し得る）。
// 60はVercel Hobbyプランの一般的な上限を前提にした値 -- 実際のプロジェクト設定は
// 本番反映前にVercelダッシュボードで確認すること。
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export default async function DashboardBlogStyleProfilePage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  const [settings, posts, profile] = await Promise.all([
    getSalonSettings(salon.id),
    listReferencePosts(salon.id),
    getStyleProfile(salon.id),
  ]);

  const selectedCount = posts.filter((p) => p.useForStyle).length;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/dashboard/blog/settings"
        className="self-start text-sm text-ink-muted transition hover:text-sage-dark"
      >
        ← 設定に戻る
      </Link>

      <PageHeader
        title="文体を学習する"
        description="過去にスタッフが書いたブログを取り込み、このサロンらしい文体でブログが生成されるようにします。"
      />

      <HotPepperImportPanel initialUrl={settings.hotpepperBlogUrl} />
      <ReferencePostList posts={posts} />
      <StyleProfilePanel selectedCount={selectedCount} profile={profile} />
    </div>
  );
}
