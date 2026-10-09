import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AuthShell from "@/components/auth/AuthShell";
import Alert from "@/components/ui/Alert";
import InviteLanding from "@/components/line/InviteLanding";
import { continuePath, INVALID_INVITE_MESSAGES } from "@/lib/notifications/line/login/messages";
import { isLineInviteAvailable } from "@/lib/notifications/line/login/config";
import { parseFlowId } from "@/lib/notifications/line/login/flow";

// スタッフが招待のリンクを開くページ(ログイン不要。店舗の管理画面の権限は与えない)。
// 招待を開いたあとはアドレスバーが /line/invite?f=<進行の id> になる。再読み込みしたら、同じ招待の結果ページへ移る
// (id は結果ページで cookie と照合する)。
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "予約通知のLINE登録",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function LineInvitePage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const flowId = parseFlowId((await searchParams).f);
  if (flowId) redirect(continuePath(flowId));
  return (
    <AuthShell title="予約通知のLINE登録">
      {isLineInviteAvailable() ? <InviteLanding /> : <Alert variant="warning">{INVALID_INVITE_MESSAGES.unavailable}</Alert>}
    </AuthShell>
  );
}
