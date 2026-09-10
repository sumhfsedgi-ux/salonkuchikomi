import ComingSoon from "@/components/dashboard/ComingSoon";
import { BlogIcon } from "@/components/ui/icons";

// Intentionally static -- no Supabase query, no fetch, no import of
// blog-app's code or API. Blog generation is a separate app today; this
// page only reserves its place in the navigation until real integration
// happens in a later project.
export default function DashboardBlogPage() {
  return (
    <ComingSoon
      icon={BlogIcon}
      title="ブログ"
      pageDescription="Hot PepperブログをAIで作成"
      bodyText="ブログ作成機能は近日公開予定です。公開までしばらくお待ちください。"
    />
  );
}
