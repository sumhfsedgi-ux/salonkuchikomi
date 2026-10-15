import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import ReplyStatusBadge from "@/components/reviews/inbox/ReplyStatusBadge";
import { policyViolationMessage, replyDisplayState, REPLY_STATE_NOTE } from "@/lib/googleReviews/replyState";
import { formatReviewDate } from "@/lib/googleReviews/format";
import type { GoogleReply, ReplyOperationState } from "@/lib/googleReviews/types";

// Google 上の返信とその状態(計画 第2版 §2「返信の状態」)。
// 審査中・公開済み・公開できなかった を区別し、公開できなかった理由(policyViolation)を分かりやすく出す。
// SalonPack から送った返信は、Google が受け付けたことと公開されたか(審査)を分けて表示する(取り直すまで公開済みにしない)。
// 結果が分からない状態(送信結果を確認中)では、もう一度送るよう促さない。
export default function GoogleReplyBlock({ reply, operation }: { reply: GoogleReply | null; operation: ReplyOperationState }) {
  const state = replyDisplayState({ reply, operation });
  const note = REPLY_STATE_NOTE[state];
  if (!reply) {
    if (state === "unreplied") return <p className="text-sm text-ink-muted">まだGoogleで返信していません。</p>;
    return (
      <Card className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">Googleの返信</h3>
          <ReplyStatusBadge state={state} />
        </div>
        {note && <p className="text-sm text-ink-muted">{note}</p>}
        {state === "sending" && <p className="text-sm text-ink-muted">SalonPackからGoogleに送っています。</p>}
      </Card>
    );
  }
  const violation = reply.state === "REJECTED" ? policyViolationMessage(reply.policyViolation) : null;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">Googleの返信</h3>
        <ReplyStatusBadge state={state} />
      </div>
      {state === "pending" && <p className="text-sm text-ink-muted">Googleで確認されています。公開まで時間がかかることがあります。</p>}
      {note && <p className="text-sm text-ink-muted">{note}</p>}
      {violation && (
        <Alert variant="error" className="flex flex-col gap-1">
          <span className="font-medium">この返信は公開できませんでした。</span>
          <span>{violation.message}</span>
          {violation.code && <span className="text-xs">詳細コード：{violation.code}</span>}
          <span>文章を直して、置き換えてください。</span>
        </Alert>
      )}
      <p className="whitespace-pre-wrap break-words text-sm text-ink">{reply.comment}</p>
      <p className="text-xs text-ink-muted">{formatReviewDate(reply.updateTime)}</p>
    </Card>
  );
}
