import type { Metadata } from "next";
import { cookies } from "next/headers";
import AuthShell from "@/components/auth/AuthShell";
import Alert from "@/components/ui/Alert";
import { InviteSummary, StartLineLoginForm } from "@/components/line/InviteSummary";
import { INVALID_INVITE_MESSAGES, type ContinueNotice } from "@/lib/notifications/line/login/messages";
import { isLineInviteAvailable } from "@/lib/notifications/line/login/config";
import { BINDING_COOKIE, bindingHashOf, flowView, type FlowView } from "@/lib/notifications/line/login/flow";

// LINE 連携の結果と再試行のページ(ログイン不要)。URL の f(進行の id)で指定した招待の、サーバーに記録した結果だけを
// 表示する(URL のパラメータで「登録できた」とは判断しない)。id は、このブラウザ(cookie)の進行のときだけ使う
// (別のブラウザ・改ざんした id では何も表示しない)。ブラウザ全体の「最新の招待」には切り替えない。
// 店舗名は登録した通知先の記録から表示する。
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "予約通知のLINE登録",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const RETRY_MESSAGES: Record<string, string> = {
  cancelled: "LINEでの連携がキャンセルされました。登録する場合は、もう一度お試しください。",
  not_friend: "公式アカウントが友だちに追加されていないため、登録できませんでした。もう一度お試しのうえ、友だち追加の画面で追加を選んでください。",
  temporary_failure: "通信の問題などで、登録を完了できませんでした。もう一度お試しください。",
};

const NOTICE_MESSAGES: Record<ContinueNotice, string> = {
  browser: "LINEの連携を始めたときと同じブラウザで、お店の方から届いたリンクを開き直してください。",
  expired: "LINEの画面を開いてから時間が経ったため、登録を完了できませんでした。もう一度お試しください。",
  start_failed: RETRY_MESSAGES.temporary_failure,
};

function isNotice(value: string | undefined): value is ContinueNotice {
  return value === "browser" || value === "expired" || value === "start_failed";
}

function Body({ flow, notice }: { flow: FlowView | null; notice: ContinueNotice | undefined }) {
  if (!flow) {
    return <Alert variant="warning">{notice === "browser" ? NOTICE_MESSAGES.browser : "お店の方から届いた招待のリンクを、もう一度開いてください。"}</Alert>;
  }
  if (flow.lastOutcome === "registered" && flow.registeredSalonName) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="success">
          {flow.registeredSalonName} の予約通知の通知先に追加されました。
        </Alert>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
          <li>お店の予約通知が稼働している間、予約の情報がこのLINEに届きます。</li>
          <li>このLINEアカウントへメッセージを送る必要はありません。</li>
          <li>この画面は閉じてかまいません。</li>
        </ul>
      </div>
    );
  }
  if (flow.lastOutcome === "already_registered" && flow.registeredSalonName) {
    return (
      <Alert variant="success">
        このLINEは、すでに {flow.registeredSalonName} の予約通知の通知先に登録されています。あらためて登録する必要はありません。
      </Alert>
    );
  }
  if (flow.inviteStatus !== "valid") {
    return <Alert variant="warning">{INVALID_INVITE_MESSAGES[flow.inviteStatus] ?? INVALID_INVITE_MESSAGES.not_found}</Alert>;
  }
  const message = notice && notice !== "browser" ? NOTICE_MESSAGES[notice] : flow.lastOutcome ? RETRY_MESSAGES[flow.lastOutcome] : null;
  return (
    <div className="flex flex-col gap-4">
      {message && <Alert variant="warning">{message}</Alert>}
      <InviteSummary salonName={flow.salonName} displayName={flow.displayName} />
      <StartLineLoginForm flowId={flow.flowId} label={flow.lastOutcome ? "もう一度LINEで連携する" : "LINEで連携する"} />
    </div>
  );
}

export default async function LineInviteContinuePage({ searchParams }: { searchParams: Promise<{ f?: string; notice?: string }> }) {
  const params = await searchParams;
  if (!isLineInviteAvailable()) {
    return (
      <AuthShell title="予約通知のLINE登録">
        <Alert variant="warning">{INVALID_INVITE_MESSAGES.unavailable}</Alert>
      </AuthShell>
    );
  }
  const bindingHash = bindingHashOf((await cookies()).get(BINDING_COOKIE)?.value);
  const flow = await flowView(params.f, bindingHash);
  const notice = isNotice(params.notice) ? params.notice : params.f && !flow ? "browser" : undefined;
  return (
    <AuthShell title="予約通知のLINE登録">
      <Body flow={flow} notice={notice} />
    </AuthShell>
  );
}
