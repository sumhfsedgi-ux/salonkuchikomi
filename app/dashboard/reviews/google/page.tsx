import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { getInboxPageContext } from "@/lib/googleReviews/pageContext";

// 届いた口コミの「口コミを選んでいない」状態。見出し・タブ・一覧・連携の案内は layout。
// 2列のとき右側に「口コミを選んでください」(自動では選ばない＝既読にしない)。1列では一覧だけが見える。
export default async function DashboardReviewsGooglePage() {
  const { connection } = await getInboxPageContext();
  if (connection.kind !== "connected") return null;
  return (
    <Card>
      <EmptyState title="口コミを選んでください" description="左の一覧から口コミを選ぶと、ここに内容が表示されます。" />
    </Card>
  );
}
