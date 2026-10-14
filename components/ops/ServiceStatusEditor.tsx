"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveServiceStatusAction } from "@/app/ops/salons/[id]/actions";
import type { FeatureKey } from "@/lib/features/registry";
import type { OverrideMode } from "@/lib/features/entitlements";
import type { SalonPlan } from "@/lib/access/plan";
import type { CatalogEntry, PlanRules } from "@/lib/ops/preview";
import { serviceStatusChangeNotes, usableFeatureLabels } from "@/lib/ops/onboardingDisplay";
import { SERVICE_STATUS_DESCRIPTIONS, SERVICE_STATUS_LABELS, type ServiceStatus } from "@/lib/onboarding/serviceStatus";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Label from "@/components/ui/Label";
import ConfirmDialog from "@/components/ops/ConfirmDialog";
import ServiceStatusBadge from "@/components/ops/ServiceStatusBadge";

// 利用区分の変更(運営)。無償提供・テスト店舗にすると、許可された機能を使えるようになる(利用開始)。
// 区分だけを変え、契約プラン・機能の利用許可・権限による停止・予約通知の稼働状態は変えない。確認のうえ保存する。
const STATUSES: ServiceStatus[] = ["pending", "complimentary", "test"];

export default function ServiceStatusEditor({
  salonId,
  version,
  status,
  plan,
  catalog,
  rules,
  overrides,
  reservationActive,
}: {
  salonId: string;
  version: number;
  status: ServiceStatus;
  plan: SalonPlan;
  catalog: Partial<Record<FeatureKey, CatalogEntry>>;
  rules: PlanRules;
  overrides: Partial<Record<FeatureKey, OverrideMode>>;
  reservationActive: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ServiceStatus>(status);
  const [baseVersion, setBaseVersion] = useState(version);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; conflict?: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  // 保存のあと、読み直した値が届いたら下書きをそろえる
  if (version !== baseVersion) {
    setBaseVersion(version);
    setDraft(status);
  }
  const dirty = draft !== status;
  const before = usableFeatureLabels(catalog, rules, plan, overrides, status);
  const after = usableFeatureLabels(catalog, rules, plan, overrides, draft);

  function save() {
    startTransition(async () => {
      const res = await saveServiceStatusAction({ salonId, expectedVersion: version, expectedStatus: status, newStatus: draft, note: note || undefined });
      setConfirming(false);
      setResult(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error, conflict: res.conflict });
      if (res.ok) setNote("");
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-muted">現在の利用区分:</span>
        <ServiceStatusBadge status={status} />
      </div>
      <div aria-live="polite">
        {result && (
          <Alert variant={result.ok ? "success" : "error"}>
            {result.text}
            {result.conflict && (
              <>
                {" "}
                <button type="button" className="underline" onClick={() => router.refresh()}>
                  再読み込み
                </button>
              </>
            )}
          </Alert>
        )}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">変更後の利用区分</legend>
        {STATUSES.map((s) => (
          <label key={s} className="flex min-h-11 items-start gap-2 text-sm text-ink">
            <input type="radio" name={`service-status-${salonId}`} className="mt-1" checked={draft === s} disabled={pending} onChange={() => setDraft(s)} />
            <span>
              <span className="font-medium">{SERVICE_STATUS_LABELS[s]}</span>
              {s === status && <span className="ml-1 text-xs text-ink-muted">(現在)</span>}
              <span className="block text-xs text-ink-muted">{SERVICE_STATUS_DESCRIPTIONS[s]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={!dirty || pending} onClick={() => setConfirming(true)}>
          変更内容を確認
        </Button>
        <Button type="button" variant="secondary" disabled={!dirty || pending} onClick={() => setDraft(status)}>
          変更を取り消す
        </Button>
        <span className="text-xs text-ink-muted">{dirty ? "この変更はまだ反映されていません。" : "変更はありません。"}</span>
      </div>

      {confirming && (
        <ConfirmDialog
          title="利用区分の変更の確認"
          busy={pending}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button type="button" variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
                戻る
              </Button>
              <Button type="button" disabled={pending} onClick={save}>
                {pending ? "保存しています..." : "この内容で保存"}
              </Button>
            </>
          }
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {serviceStatusChangeNotes({ from: status, to: draft, before, after, reservationActive }).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div>
            <Label htmlFor={`service-note-${salonId}`}>変更理由のメモ(任意・500文字まで)</Label>
            <textarea
              id={`service-note-${salonId}`}
              value={note}
              maxLength={500}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border border-greige bg-white px-3 py-2.5 text-base text-ink focus:border-sage focus:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
            />
            <p className="mt-1 text-xs text-ink-muted">メモは変更履歴に残ります(あとから編集・削除はできません)。</p>
          </div>
        </ConfirmDialog>
      )}
    </Card>
  );
}
