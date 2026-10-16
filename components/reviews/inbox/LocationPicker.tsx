"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import { ExternalLinkIcon } from "@/components/ui/icons";
import type { ActionResult, GbpAccountOption, GbpLocationOption } from "@/lib/googleReviews/types";

// 連携する店舗(Google 上の店舗)を選ぶ(計画 第2版 §2 操作の流れ 3)。1件でも選んでもらう(自動では選ばない)。
// 同意を記録した店舗にだけ出す(同意の前は、店舗の候補も取らない。lib/gbp/inbox.ts)。
// 選ぶと、サーバーが最初の取り込みを行い、画面を読み直す。

const GOOGLE_BUSINESS_URL = "https://business.google.com/";

const UNAVAILABLE: Record<NonNullable<GbpLocationOption["unavailableReason"]>, { title: string; next: string; googleLink: boolean }> = {
  unverified: {
    title: "オーナー確認が必要です",
    next: "Googleで店舗のオーナー確認を完了すると、選択できます。",
    googleLink: true,
  },
  linked_elsewhere: {
    title: "SalonPackの別の店舗と連携済みです",
    next: "連携している店舗で接続を解除すると、選択できます。",
    googleLink: false,
  },
};

interface Props {
  accounts: GbpAccountOption[];
  select: (input: { locationName: string }) => Promise<ActionResult>;
}

/** 店舗の一覧を Google から取り直す(画面を読み直すと、サーバーがもう一度一覧を取得する)。 */
export function ReloadLocationsButton({ variant = "ghost" }: { variant?: "primary" | "secondary" | "ghost" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button type="button" variant={variant} onClick={() => startTransition(() => router.refresh())} disabled={pending}>
      {pending ? "読み込んでいます…" : "店舗一覧を再読み込み"}
    </Button>
  );
}

export default function LocationPicker({ accounts, select }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const selectable = accounts.some((account) => account.locations.some((location) => location.unavailableReason === null));

  function submit() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      let result: ActionResult;
      try {
        result = await select({ locationName: selected });
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
        <legend className="sr-only">連携する店舗</legend>
        {accounts.map((account) => (
          <div key={account.accountName} className="flex flex-col gap-2">
            {accounts.length > 1 && <p className="text-xs font-semibold text-ink-muted">{account.displayName}</p>}
            {account.locations.length === 0 ? (
              <p className="rounded-lg border border-border p-3 text-xs text-ink-muted">このアカウントで管理している店舗はありません</p>
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {account.locations.map((location) => {
                  const reason = location.unavailableReason ? UNAVAILABLE[location.unavailableReason] : null;
                  const inputId = `loc-${location.locationName}`;
                  return (
                    <div key={location.locationName} className="flex flex-col gap-2 p-3">
                      <label htmlFor={inputId} className={reason ? "flex items-start gap-3 text-ink-muted" : "flex cursor-pointer items-start gap-3"}>
                        <input
                          id={inputId}
                          type="radio"
                          name="gbp-location"
                          value={location.locationName}
                          disabled={reason !== null || pending}
                          checked={selected === location.locationName}
                          onChange={() => setSelected(location.locationName)}
                          className="mt-0.5 h-5 w-5 shrink-0 accent-sage-dark"
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="break-words text-sm font-medium text-ink">{location.title}</span>
                          {location.address && <span className="break-words text-xs text-ink-muted">{location.address}</span>}
                        </span>
                      </label>
                      {reason && (
                        <div className="ml-8 flex flex-col gap-1 text-xs">
                          <span className="font-medium text-warning">{reason.title}</span>
                          <span className="text-ink-muted">{reason.next}</span>
                          {reason.googleLink && (
                            <a
                              href={GOOGLE_BUSINESS_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex w-fit items-center gap-1 font-medium text-sage-dark underline underline-offset-2"
                            >
                              Googleの管理画面を開く
                              <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </fieldset>

      {error && <Alert variant="error">{error}</Alert>}

      {selectable && (
        <Button type="button" className="self-start" onClick={submit} disabled={!selected || pending}>
          {pending ? "口コミを取り込んでいます…" : "この店舗と連携する"}
        </Button>
      )}
    </div>
  );
}
