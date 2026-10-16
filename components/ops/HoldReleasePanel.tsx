"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import Label from "@/components/ui/Label";
import { releaseHoldAction } from "@/app/ops/salons/[id]/actions";

// 権限による停止の解除(運営が明示的に行う)。利用許可の保存とは別の操作にする。
// 解除しても、受信OFF・お客様の利用停止・運営による停止・旧側の切り替え条件はそのまま残る(残るものを表示する)。

interface Props {
  salonId: string;
  featureKey: "reservation_notifications" | "reviews" | "blog";
  featureLabel: string;
  holdId: string;
  /** 今、利用許可があるか(無ければ解除できない)。 */
  entitled: boolean;
  /** 使えない理由が、利用区分が利用開始待ちであること(利用許可の保存では再開しない)。 */
  servicePending?: boolean;
  /** 解除しても残る停止(表示用)。 */
  remaining: string[];
}

export default function HoldReleasePanel({ salonId, featureKey, featureLabel, holdId, entitled, servicePending = false, remaining }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (!entitled && servicePending) {
    return (
      <p className="text-sm text-ink-muted">
        利用区分が「利用開始待ち」のため、解除できません。先に「利用区分」を利用中に戻してください(「契約プラン・使える機能」の保存では再開しません)。
      </p>
    );
  }
  if (!entitled) {
    return <p className="text-sm text-ink-muted">利用を許可していないため、解除できません。先に「契約プラン・使える機能」で利用を許可して保存してください。</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {result && <Alert variant={result.ok ? "success" : "error"}>{result.text}</Alert>}
      {!open ? (
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {featureLabel}の停止を解除する
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-ivory p-4">
          <p className="text-sm font-semibold text-ink">{featureLabel}の「権限による停止」を解除します</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
            <li>解除したあとに届いた予約から、通知の対象になります(停止中に届いた予約は通知しません)。</li>
            {remaining.length > 0 ? (
              <li>次の停止は解除されず、残ります: {remaining.join("・")}</li>
            ) : (
              <li>ほかの停止はありません。解除すると、次の確認から予約メールの確認と通知を再開します。</li>
            )}
          </ul>
          <div className="mt-3">
            <Label htmlFor="release-note">理由のメモ(任意・500文字まで)</Label>
            <textarea
              id="release-note"
              value={note}
              maxLength={500}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border border-greige bg-white px-3 py-2.5 text-base text-ink focus:border-sage focus:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              戻る
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await releaseHoldAction({ salonId, featureKey, holdId, note: note.trim() || undefined });
                  if (res.ok) {
                    // 解除するとこの欄は消えるため、結果は詳細の画面の上に出す(読み直した状態と一緒に)。
                    router.replace(`/ops/salons/${salonId}?released=${featureKey}#integrations`);
                    return;
                  }
                  setResult({ ok: false, text: res.error });
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {pending ? "解除しています…" : "解除する"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
