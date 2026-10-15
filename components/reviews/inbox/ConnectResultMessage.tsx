"use client";

import { useSearchParams } from "next/navigation";
import Alert from "@/components/ui/Alert";

// Google との連携から届いた口コミの画面に戻ってきたときの結果(app/api/google/oauth/callback の ?google=...)。
// 一覧の上に出す(1列の表示でも見えるように、layout に置く)。
const MESSAGES: Record<string, { variant: "success" | "error" | "warning"; text: string }> = {
  connected: { variant: "success", text: "Googleとの連携が完了しました。" },
  denied: { variant: "warning", text: "Googleで許可されませんでした。必要なときにもう一度お試しください。" },
  state_invalid: { variant: "error", text: "連携の途中でログイン状態や店舗が変わったか、時間がたちすぎたため中止しました。もう一度お試しください。" },
  account_mismatch: { variant: "error", text: "連携中のGoogleアカウントと違うアカウントが選ばれたため、保存していません。" },
  no_scope_granted: { variant: "warning", text: "口コミの権限が許可されなかったため、連携していません。" },
  no_refresh_token: { variant: "error", text: "Googleから必要な情報を受け取れませんでした。もう一度お試しください。" },
  scope_regression: { variant: "error", text: "今まで許可されていた権限が含まれていなかったため、連携を変更していません。" },
  revocation_in_progress: { variant: "warning", text: "以前の連携の解除を処理しています。少し時間をおいてもう一度お試しください。" },
  feature_not_allowed: { variant: "error", text: "ご契約に含まれていない機能です。" },
  not_available: { variant: "warning", text: "届いた口コミは現在ご利用いただけません。" },
  not_connected: { variant: "warning", text: "Googleと連携していません。" },
  consent_required: { variant: "warning", text: "口コミの取り扱いについて確認し、チェックを入れてください。" },
  consent_failed: { variant: "error", text: "確認の内容を記録できませんでした。もう一度お試しください。" },
  start_failed: { variant: "error", text: "Googleとの連携を始められませんでした。少し時間をおいて、もう一度お試しください。" },
};

const FOLLOW_UP = {
  selecting: " 口コミを受け取るビジネスを選んでください。",
  consent_required: " 口コミの取り扱いについて確認してください。",
} as const;

export default function ConnectResultMessage({ next }: { next: keyof typeof FOLLOW_UP | null }) {
  const params = useSearchParams();
  const key = params.get("google");
  const message = key ? MESSAGES[key] : undefined;
  if (!message) return null;
  return (
    <Alert variant={message.variant}>
      {message.text}
      {key === "connected" && next ? FOLLOW_UP[next] : ""}
    </Alert>
  );
}
