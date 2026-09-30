import { createClient } from "@/lib/supabase/server";
import { requireFeatureAccess } from "@/lib/access/featureAccess";
import PageHeader from "@/components/ui/PageHeader";
import BlogSubNav from "@/components/blog/BlogSubNav";
import CreateFlow from "@/components/blog/create/CreateFlow";

export default async function DashboardBlogPage() {
  const supabase = await createClient();
  await requireFeatureAccess(supabase, "blog");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="ブログ" description="Hot PepperブログをAIで作成" />
      <BlogSubNav />
      <CreateFlow />
    </div>
  );
}
