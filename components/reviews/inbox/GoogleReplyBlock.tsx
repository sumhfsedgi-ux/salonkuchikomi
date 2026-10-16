import type { ReactNode } from "react";
import Card from "@/components/ui/Card";
import ReplyStatusBadge from "@/components/reviews/inbox/ReplyStatusBadge";
import { policyViolationMessage, replyDisplayState } from "@/lib/googleReviews/replyState";
import { formatReviewDate } from "@/lib/googleReviews/format";
import type { GoogleReply, ReplyOperationState } from "@/lib/googleReviews/types";

// Google 上の返信(最後に取り直した内容)と、その状態(計画 第2版 §2「返信の状態」)。
//   ・審査中・公開済み・公開できなかった は、取り直した Google のデータ(reviewReplyState)だけで表示する。
//   ・公開できなかった理由は、Google が理由(policyViolation)を返したときだけ出す(推測で理由を書かない)。
//   ・送信中・送信結果を確認中・反映を確認できていない あいだは、状態の説明と操作を返信の欄(ReviewComposer)に1回だけ出す。
//     ここでは、最後に確認した返信の内容だけを出す(状態のバッジ・説明を繰り返さない)。
//   ・返信が無いときは何も出さない(返信の欄が「返信を作成」を出す)。
export default function GoogleReplyBlock({
  reply,
  operation,
  children,
}: {
  reply: GoogleReply | null;
  operation: ReplyOperationState;
  /** 返信の下に置く操作(「返信を編集」・その他の操作)。 */
  children?: ReactNode;
}) {
  if (!reply) return null;
  const state = replyDisplayState({ reply, operation });
  const inFlight = state === "sending" || state === "unconfirmed" || state === "checking";
  const violation = reply.state === "REJECTED" && reply.policyViolation ? policyViolationMessage(reply.policyViolation) : null;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">Googleの返信</h3>
        {inFlight ? <span className="text-xs text-ink-muted">最後に確認した内容</span> : <ReplyStatusBadge state={state} />}
      </div>
      {violation && (
        <p className="rounded-lg border border-red-200 bg-danger-soft p-3 text-sm text-danger">
          理由:{violation.message}
          {violation.code && <span className="mt-1 block text-xs">詳細コード:{violation.code}</span>}
        </p>
      )}
      <p className="whitespace-pre-wrap break-words text-sm text-ink">{reply.comment}</p>
      <p className="text-xs text-ink-muted">{formatReviewDate(reply.updateTime)}</p>
      {children}
    </Card>
  );
}
