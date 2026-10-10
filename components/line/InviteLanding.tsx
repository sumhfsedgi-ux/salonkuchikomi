"use client";

import { useEffect, useRef, useState } from "react";
import Alert from "@/components/ui/Alert";
import { InviteSummary, StartLineLoginForm } from "@/components/line/InviteSummary";
import { continuePath, INVALID_INVITE_MESSAGES } from "@/lib/notifications/line/login/messages";

// 招待のリンク(/line/invite#<招待の値>)を開いたスタッフの画面。
// 招待の値は URL のフラグメントから読み取り、POST の本文で一度だけサーバーへ送り、すぐにアドレスバーから消す
// (アクセスログ・Referer・ブラウザの履歴に残しにくくするため)。表示するのは店舗名と表示名だけ
// (既存の通知先や予約の情報は受け取らない)。SalonPack のアカウント・ログインは不要。
// 開いた招待の進行の id をこの画面に持ち、連携の開始はその id で行う(別のタブで別の招待を開いても取り違えない)。
// アドレスバーは /line/invite?f=<進行の id> にするので、再読み込みしても同じ招待の結果ページへ移る。

type OpenResult =
  | { status: "valid"; flowId: string; salonName: string; displayName: string }
  | { status: "expired" | "used" | "revoked" | "not_found" | "unavailable" | "error" };

export default function InviteLanding() {
  const [result, setResult] = useState<OpenResult | null>(null);
  // 招待の値の読み取り・送信は1回だけ(開発時の StrictMode で effect が2回動いても、2回目にアドレスバーから
  // 消えた値を「無い」と誤解しない)。
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.replace(/^#/, "");
    if (!token) {
      // 招待の値も進行の id も無い(招待を開く前に再読み込みしたなど)。どの招待かは分からないので、
      // このブラウザの別の招待には切り替えず、結果ページ(進行の指定なし = リンクを開き直す案内だけ)へ移す。
      window.location.replace(continuePath(null));
      return;
    }
    window.history.replaceState(null, "", "/line/invite");
    fetch("/api/line/invite/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((res) => res.json() as Promise<OpenResult>)
      .then((opened) => {
        if (opened.status === "valid") {
          window.history.replaceState(null, "", `/line/invite?f=${encodeURIComponent(opened.flowId)}`);
        }
        setResult(opened);
      })
      .catch(() => setResult({ status: "error" }));
  }, []);

  if (!result) return <p className="text-sm text-ink-muted">招待を確認しています...</p>;
  if (result.status !== "valid") return <Alert variant="warning">{INVALID_INVITE_MESSAGES[result.status]}</Alert>;

  return (
    <div className="flex flex-col gap-4">
      <InviteSummary salonName={result.salonName} displayName={result.displayName} />
      <StartLineLoginForm flowId={result.flowId} />
    </div>
  );
}
