"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import { CONSENT_ITEMS } from "@/components/reviews/inbox/connectCopy";
import type { ActionResult, GbpAccountOption, GbpLocationOption } from "@/lib/googleReviews/types";

// 口コミを受け取る店舗(Google のビジネス)を選ぶ(計画 第2版 §2 操作の流れ 3)。1件でも選んでもらう(自動では選ばない)。
// 連携の前の同意がまだ無い(Google連携の画面から連携した)ときは、ここで同意のチェックを求める。
// 選ぶと、サーバーが最初の取り込みを行い、画面を読み直す。

const UNAVAILABLE_REASON: Record<NonNullable<GbpLocationOption["unavailableReason"]>, string> = {
  unverified: "Googleでオーナー確認が済んでいないため選べません",
  linked_elsewhere: "ほかの店舗と連携済みのため選べません",
};

interface Props {
  accounts: GbpAccountOption[];
  needsConsent: boolean;
  select: (input: { locationName: string; consent: boolean }) => Promise<ActionResult>;
}

export default function LocationPicker({ accounts, needsConsent, select }: Props) {
  const router = useRouter();
  const consentId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      let result: ActionResult;
      try {
        result = await select({ locationName: selected, consent: consented });
      } catch {
        result = { ok: false, error: "店舗を選べませんでした。もう一度お試しください。" };
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-4">
        <legend className="sr-only">口コミを受け取るビジネス</legend>
        {accounts.map((account) => (
          <div key={account.accountName} className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-ink-muted">{account.displayName}</p>
            {account.locations.length === 0 ? (
              <p className="rounded-lg border border-border p-3 text-xs text-ink-muted">このアカウントで管理しているビジネスはありません</p>
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {account.locations.map((location) => {
                  const disabled = location.unavailableReason !== null;
                  const inputId = `loc-${location.locationName}`;
                  return (
                    <label
                      key={location.locationName}
                      htmlFor={inputId}
                      className={disabled ? "flex items-start gap-3 p-3 text-ink-muted" : "flex cursor-pointer items-start gap-3 p-3 hover:bg-ivory"}
                    >
                      <input
                        id={inputId}
                        type="radio"
                        name="gbp-location"
                        value={location.locationName}
                        disabled={disabled || pending}
                        checked={selected === location.locationName}
                        onChange={() => setSelected(location.locationName)}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-sage-dark"
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="break-words text-sm font-medium text-ink">{location.title}</span>
                        {location.address && <span className="break-words text-xs text-ink-muted">{location.address}</span>}
                        {location.unavailableReason && (
                          <span className="text-xs text-warning">{UNAVAILABLE_REASON[location.unavailableReason]}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </fieldset>

      {needsConsent && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-ivory p-3">
          <p className="text-sm font-semibold text-ink">口コミの取り扱いについて</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-muted">
            {CONSENT_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <label htmlFor={consentId} className="flex items-start gap-2 text-sm text-ink">
            <input
              id={consentId}
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              disabled={pending}
              className="mt-0.5 h-5 w-5 shrink-0 accent-sage-dark"
            />
            上の内容を確認しました
          </label>
        </div>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      <Button type="button" className="self-start" onClick={submit} disabled={!selected || pending || (needsConsent && !consented)}>
        {pending ? "口コミを取り込んでいます…" : "この店舗の口コミを受け取る"}
      </Button>
    </div>
  );
}
