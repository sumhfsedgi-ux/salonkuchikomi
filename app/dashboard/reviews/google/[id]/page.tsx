import Link from "next/link";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import ReviewDetailView from "@/components/reviews/inbox/ReviewDetailView";
import { getInboxPageContext } from "@/lib/googleReviews/pageContext";
import { INBOX_PATH } from "@/lib/googleReviews/query";
import { generateReplyForReviewAction } from "@/app/dashboard/reviews/google/actions";
import {
  checkReviewAction,
  dismissReplyOperationAction,
  saveReviewDraftAction,
  setReviewSeenAction,
  submitReplyAction,
} from "@/app/dashboard/reviews/google/inboxActions";

// 口コミの詳細(/dashboard/reviews/google/{id})。id は SalonPack 側の ID で、その店舗のデータの中でだけ探す
// (ほかの店舗の ID では見つからない)。利用可否・連携の確認は layout と同じもの(lib/googleReviews/pageContext.ts)。
export default async function DashboardReviewDetailPage({ params }: PageProps<"/dashboard/reviews/google/[id]">) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const { access, connection } = await getInboxPageContext();

  if (connection.kind !== "connected") {
    return (
      <Card>
        <EmptyState
          title="この口コミは表示できません"
          description="Googleと連携して店舗を選ぶと、届いた口コミを確認できます。"
          actions={
            <Link href={INBOX_PATH} className="text-sm font-medium text-sage-dark underline underline-offset-2">
              届いた口コミへ戻る
            </Link>
          }
        />
      </Card>
    );
  }

  const result = await access.inbox.getReview(access.ctx, id);
  return (
    <ReviewDetailView
      key={`${id}:${result.kind}`}
      id={id}
      result={result}
      actions={{
        setSeen: setReviewSeenAction,
        saveDraft: saveReviewDraftAction,
        checkReview: checkReviewAction,
        generate: generateReplyForReviewAction,
        submitReply: submitReplyAction,
        dismissOperation: dismissReplyOperationAction,
      }}
      target={{ salonName: access.salon.name, locationTitle: connection.location.title }}
    />
  );
}
