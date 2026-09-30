import { createClient } from "@/lib/supabase/server";
import { requireFeatureAccess } from "@/lib/access/featureAccess";
import { listPosts } from "@/lib/blog/queries";
import PageHeader from "@/components/ui/PageHeader";
import BlogSubNav from "@/components/blog/BlogSubNav";
import HistoryListItem from "@/components/blog/history/HistoryListItem";

// 常に最新の履歴を返す必要があるため、ビルド時の静的プリレンダリングは行わない。
export const dynamic = "force-dynamic";

export default async function DashboardBlogHistoryPage() {
  const supabase = await createClient();
  const salon = await requireFeatureAccess(supabase, "blog");

  const posts = await listPosts(salon.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="過去の記事" />
      <BlogSubNav />

      {posts.length === 0 ? (
        <p className="text-sm text-ink-muted">
          まだブログがありません。「作成」からはじめての記事を作ってみましょう。
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {posts.map((post) => (
            <li key={post.id}>
              <HistoryListItem post={post} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
