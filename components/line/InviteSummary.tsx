import { buttonClassName } from "@/components/ui/Button";

// 招待ページ・結果ページで共通の、招待の説明と「LINEで連携する」ボタン(サーバー・クライアントの両方から使う)。
// フォームは、画面に表示した招待の進行の id を送る(サーバーで cookie と照合してから使う)。

export function InviteSummary({ salonName, displayName }: { salonName: string; displayName: string }) {
  return (
    <>
      <p className="text-sm text-ink">
        <span className="font-semibold">{salonName}</span> の予約通知の通知先に、あなたのLINEを登録します。
      </p>
      <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-sm">
        <dt className="text-ink-muted">表示名</dt>
        <dd className="text-ink">{displayName}</dd>
      </dl>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
        <li>このお店の予約の情報(予約の日時・メニュー・お客様のお名前など)が、あなたのLINEに届きます。</li>
        <li>SalonPackのアカウントの作成やログインは不要です。</li>
        <li>LINEの画面で、公式アカウントの友だち追加をお願いします(追加しないと通知が届きません)。</li>
      </ul>
    </>
  );
}

export function StartLineLoginForm({ flowId, label = "LINEで連携する" }: { flowId: string; label?: string }) {
  return (
    <form method="post" action="/api/line/login/start">
      <input type="hidden" name="flow" value={flowId} />
      <button type="submit" className={buttonClassName({ fullWidth: true })}>
        {label}
      </button>
    </form>
  );
}
