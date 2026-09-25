import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { getPost } from "@/lib/blog/queries";
import HistoryDetail from "@/components/blog/history/HistoryDetail";

export const dynamic = "force-dynamic";

export default async function DashboardBlogHistoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  const { id } = await params;
  const post = await getPost(salon.id, id);
  if (!post) notFound();

  return <HistoryDetail post={post} />;
}
