import { getInboxPageContext } from "@/lib/googleReviews/pageContext";
import { DEFAULT_LIST_QUERY } from "@/lib/googleReviews/query";
import { isSimulatedGoogleEnabled } from "@/lib/google/config";
import PageHeader from "@/components/ui/PageHeader";
import Alert from "@/components/ui/Alert";
import ReviewsSubNav from "@/components/reviews/ReviewsSubNav";
import ReviewsInbox from "@/components/reviews/inbox/ReviewsInbox";
import InboxConnectionNotice from "@/components/reviews/inbox/InboxConnectionNotice";
import ConnectResultMessage from "@/components/reviews/inbox/ConnectResultMessage";
import {
  agreeReviewsConsentAction,
  listReviewsAction,
  refreshReviewsAction,
  selectLocationAction,
  startReviewsConnectAction,
} from "@/app/dashboard/reviews/google/inboxActions";
import { stopFeatureAction } from "@/app/dashboard/settings/google/actions";

// 届いた口コミ(計画 第2版 §2)。「口コミ」の中のタブの1つ。
// 一覧はこの layout に置くので、詳細(/[id])へ移っても一覧の状態が残る。
// 店舗を選んで使える状態になるまでは、連携・権限の追加・店舗の選択の案内を出す。
// 使えない店舗は 404(lib/googleReviews/pageContext.ts)。
export const dynamic = "force-dynamic";

export default async function DashboardReviewsGoogleLayout({ children }: LayoutProps<"/dashboard/reviews/google">) {
  const context = await getInboxPageContext();
  const { access, connection } = context;
  const initialResult = connection.kind === "connected" ? await access.inbox.listReviews(access.ctx, DEFAULT_LIST_QUERY, null) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="口コミ" description="Googleに届いた口コミの確認と、返信ができます。" />
      <ReviewsSubNav showInbox />
      {isSimulatedGoogleEnabled() && (
        <Alert variant="warning">検証用の架空のGoogleにつないでいます。実際のGoogleの口コミ・返信ではありません。</Alert>
      )}
      <ConnectResultMessage next={connection.kind === "selecting" || connection.kind === "consent_required" ? connection.kind : null} />
      {connection.kind === "connected" && initialResult ? (
        <ReviewsInbox initialResult={initialResult} actions={{ list: listReviewsAction, refresh: refreshReviewsAction }}>
          {children}
        </ReviewsInbox>
      ) : connection.kind !== "connected" ? (
        <InboxConnectionNotice
          state={connection}
          salonName={access.salon.name}
          gmailConnected={context.gmailConnected}
          gmailAccountEmail={context.gmailAccountEmail}
          connect={startReviewsConnectAction}
          agree={agreeReviewsConsentAction}
          stop={stopFeatureAction}
          select={selectLocationAction}
        />
      ) : null}
    </div>
  );
}
