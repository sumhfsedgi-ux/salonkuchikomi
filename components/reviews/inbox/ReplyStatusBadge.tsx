import Badge from "@/components/ui/Badge";
import { AlertIcon } from "@/components/ui/icons";
import { REPLY_STATE_VIEW, type ReplyDisplayState } from "@/lib/googleReviews/replyState";

// 返信の状態のバッジ(docs/plans/google-reviews-inbox-plan.md §8-3・§11)。
// エラーの状態は色だけでなく「!」のアイコンと文字で示す。未返信は点を付ける。
export default function ReplyStatusBadge({ state }: { state: ReplyDisplayState }) {
  const view = REPLY_STATE_VIEW[state];
  return (
    <Badge variant={view.tone} dot={state === "unreplied"}>
      {view.alert && <AlertIcon className="h-3.5 w-3.5" aria-hidden="true" />}
      {view.label}
    </Badge>
  );
}
