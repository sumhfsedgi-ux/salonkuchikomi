import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import PageHeader from "@/components/ui/PageHeader";
import BlogSubNav from "@/components/blog/BlogSubNav";
import CreateFlow from "@/components/blog/create/CreateFlow";

export default async function DashboardBlogPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="ブログ" description="Hot PepperブログをAIで作成" />
      <BlogSubNav />
      <CreateFlow />
    </div>
  );
}
