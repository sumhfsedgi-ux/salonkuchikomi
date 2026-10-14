import type { Metadata } from "next";
import AuthShell from "@/components/auth/AuthShell";
import AuthLinkHandler from "@/components/auth/AuthLinkHandler";

export const metadata: Metadata = {
  title: "メールのリンクの確認",
  robots: { index: false, follow: false },
  // リンクの値を、外部への遷移の Referer に載せない
  referrer: "no-referrer",
};

// メールのリンク(新規登録の確認・招待・ログインのご案内・パスワード再設定・本人確認)の受け口。
// トークンはブラウザだけで扱い、サーバーへは送らない(フラグメント。query の場合も画面ですぐ消す)。
export default function AuthConfirmPage() {
  return (
    <AuthShell title="メールのリンクの確認">
      <AuthLinkHandler />
    </AuthShell>
  );
}
