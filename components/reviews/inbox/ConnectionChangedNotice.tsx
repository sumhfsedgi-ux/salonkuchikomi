"use client";

import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

// Google連携・店舗が変わったときの案内(lib/googleReviews/messages.ts の文言)。
// 「一覧を読み込み直す」はページを読み込み直す。入力中の文章があるときは、消えることを先に伝える
// (連携・店舗が変わると、その口コミの下書きは保存できないため)。文章は返信欄から選択して控えられる。
export default function ConnectionChangedNotice({ message, text, reloadHref }: { message: string; text?: string; reloadHref: string }) {
  const hasText = Boolean(text?.trim());
  return (
    <Alert variant="warning" className="flex flex-col gap-2">
      <span>{message}</span>
      {hasText && <span>返信欄の文章は、読み込み直すと消えます。必要なら、先に文章を選択して控えてください。</span>}
      <Button type="button" size="sm" variant="secondary" className="self-start" onClick={() => window.location.assign(reloadHref)}>
        一覧を読み込み直す
      </Button>
    </Alert>
  );
}
