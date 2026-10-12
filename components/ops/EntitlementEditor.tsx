"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import { ReviewIcon, BlogIcon, BellIcon, InboxIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { SalonPlan } from "@/lib/access/plan";
import { ENTITLEMENT_REASON_LABELS, LIFECYCLE_LABELS, OVERRIDE_LABELS, type EntitlementReason, type FeatureLifecycle, type OverrideMode } from "@/lib/features/entitlements";
import type { FeatureCategory, FeatureIcon } from "@/lib/features/registry";
import { previewAccess, type CatalogEntry, type PlanRules } from "@/lib/ops/preview";
import { describeChanges } from "@/lib/ops/impact";
import { PLAN_LABELS } from "@/lib/ops/labels";
import { saveEntitlementsAction } from "@/app/ops/salons/[id]/actions";

// 契約と利用許可の編集。スイッチ(選択肢)を変えただけでは保存せず、「変更を保存」で確認を出し、
// 変更内容・影響を見てから保存する。保存の可否と保存後の値は DB が決め、保存後は DB から読み直した値を出す。
// 設定値(プランに従う/個別に許可/個別に利用不可)と、最終的な利用可否・理由を分けて文字で出す(色だけに頼らない)。

export interface EditorFeature {
  key: string;
  label: string;
  description: string;
  category: FeatureCategory;
  sortOrder: number;
  icon: FeatureIcon;
  hasRuntime: boolean;
  lifecycle: FeatureLifecycle;
  override: OverrideMode;
  allowed: boolean;
  reason: EntitlementReason;
  holdOpen: boolean;
  /** 前提条件(必要な連携など)の表示。 */
  prerequisites: string[];
}

interface Props {
  salonId: string;
  version: number;
  plan: SalonPlan;
  features: EditorFeature[];
  categories: ReadonlyArray<{ key: FeatureCategory; label: string }>;
  catalog: Partial<Record<string, CatalogEntry>>;
  rules: PlanRules;
  reservationStarted: boolean;
}

const ICONS = { review: ReviewIcon, blog: BlogIcon, bell: BellIcon, inbox: InboxIcon } as const;
const MODES: OverrideMode[] = ["inherit", "allow", "deny"];
const SEARCH_THRESHOLD = 8;

function accessLabel(a: { allowed: boolean; reason: EntitlementReason }) {
  return a.allowed ? "利用可" : "利用不可";
}

export default function EntitlementEditor({ salonId, version, plan, features, categories, catalog, rules, reservationStarted }: Props) {
  const router = useRouter();
  const savedOverrides = useMemo(() => Object.fromEntries(features.map((f) => [f.key, f.override])) as Record<string, OverrideMode>, [features]);
  const [draftPlan, setDraftPlan] = useState<SalonPlan>(plan);
  const [draftOverrides, setDraftOverrides] = useState<Record<string, OverrideMode>>(savedOverrides);
  const [baseVersion, setBaseVersion] = useState(version);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; conflict?: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  // 保存できたあと、DB から読み直した内容(新しい版数)が届くまでは操作させない(古い表示のまま選ばせない)。
  const [refreshingFrom, setRefreshingFrom] = useState<number | null>(null);
  const busy = pending || refreshingFrom !== null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // 保存のあと(または別の操作のあと)に新しい値が届いたら、下書きをその値に戻す(古い値で保存しない)。
  if (version !== baseVersion) {
    setBaseVersion(version);
    setDraftPlan(plan);
    setDraftOverrides(savedOverrides);
    setConfirming(false);
    setNote("");
    setRefreshingFrom(null);
  }

  useEffect(() => {
    if (confirming) dialogRef.current?.focus();
  }, [confirming]);

  const rows = features.map((f) => {
    const draftOverride = draftOverrides[f.key] ?? "inherit";
    const after = previewAccess(catalog[f.key], rules, draftPlan, f.key, draftOverride);
    return { f, draftOverride, after, inPlan: rules[draftPlan]?.[f.key] !== undefined };
  });
  const changedOverrides = rows.filter((r) => r.draftOverride !== r.f.override);
  const dirty = draftPlan !== plan || changedOverrides.length > 0;
  const summaries = describeChanges({
    planBefore: plan,
    planAfter: draftPlan,
    features: rows.map((r) => ({
      key: r.f.key,
      label: r.f.label,
      hasRuntime: r.f.hasRuntime,
      beforeOverride: r.f.override,
      afterOverride: r.draftOverride,
      before: { allowed: r.f.allowed, reason: r.f.reason },
      after: r.after,
      holdOpen: r.f.holdOpen,
      runtimeStarted: reservationStarted,
    })),
  });

  const visible = search.trim()
    ? rows.filter((r) => `${r.f.label}${r.f.description}`.includes(search.trim()))
    : rows;

  function reset() {
    setDraftPlan(plan);
    setDraftOverrides(savedOverrides);
    setResult(null);
  }

  function save() {
    setResult(null);
    startTransition(async () => {
      const res = await saveEntitlementsAction({
        salonId,
        expectedVersion: version,
        // 画面を開いた時点の値(全機能)。ほかの操作で1つでも変わっていれば、DB は何も書かない。
        expected: { plan, overrides: savedOverrides },
        changes: {
          ...(draftPlan !== plan ? { plan: draftPlan } : {}),
          overrides: Object.fromEntries(changedOverrides.map((r) => [r.f.key, r.draftOverride])),
        },
        note: note.trim() || undefined,
      });
      setConfirming(false);
      setResult(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error, conflict: res.conflict });
      if (res.ok && res.changed) setRefreshingFrom(version);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4" data-refreshing={refreshingFrom !== null ? "true" : undefined} aria-busy={busy}>
      {refreshingFrom !== null && (
        <p className="text-sm text-ink-muted" role="status">
          保存した内容を読み込んでいます…
        </p>
      )}
      {result && (
        <Alert variant={result.ok ? "success" : "error"}>
          {result.text}
          {result.conflict && (
            <button type="button" onClick={() => router.refresh()} className="ml-2 underline underline-offset-2">
              再読み込み
            </button>
          )}
        </Alert>
      )}

      <Card>
        <fieldset>
          <legend className="text-sm font-semibold text-ink">契約プラン</legend>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(["reviews", "salonpack"] as const).map((p) => (
              <label
                key={p}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm",
                  draftPlan === p ? "border-sage bg-sage-soft text-ink" : "border-border bg-white text-ink",
                )}
              >
                <input type="radio" name="plan" value={p} checked={draftPlan === p} disabled={busy} onChange={() => setDraftPlan(p)} className="accent-sage" />
                <span className="font-medium">{PLAN_LABELS[p]}</span>
                {p === plan && <span className="text-xs text-ink-muted">(現在の契約)</span>}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            口コミプランで使えるのは口コミだけです。ブログ・予約通知を使う場合は SalonPack に変更してください(口コミプランのまま個別に許可することはできません)。
          </p>
        </fieldset>
      </Card>

      {features.length >= SEARCH_THRESHOLD && (
        <div>
          <Label htmlFor="feature-search">機能を検索</Label>
          <Input id="feature-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="機能名・説明" />
        </div>
      )}

      {categories.map((cat) => {
        const items = visible.filter((r) => r.f.category === cat.key).sort((a, b) => a.f.sortOrder - b.f.sortOrder);
        if (items.length === 0) return null;
        return (
          <section key={cat.key} aria-labelledby={`cat-${cat.key}`} className="flex flex-col gap-3">
            <h3 id={`cat-${cat.key}`} className="text-sm font-semibold text-ink-muted">
              {cat.label}
            </h3>
            {items.map(({ f, draftOverride, after, inPlan }) => {
              const Icon = ICONS[f.icon];
              const changed = draftOverride !== f.override || after.allowed !== f.allowed || after.reason !== f.reason;
              return (
                <Card key={f.key} className="flex flex-col gap-4" data-feature={f.key}>
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sage-soft text-sage-dark" aria-hidden="true">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-base font-semibold text-ink">{f.label}</h4>
                        <Badge variant={f.allowed ? "success" : "neutral"}>{`現在: ${accessLabel(f)}`}</Badge>
                        {f.holdOpen && <Badge variant="warning">権限による停止中</Badge>}
                      </div>
                      <p className="mt-1 text-sm text-ink-muted">{f.description}</p>
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-ink-muted sm:grid-cols-2">
                        <div>
                          <dt className="inline">提供状態: </dt>
                          <dd className="inline text-ink">{LIFECYCLE_LABELS[f.lifecycle]}</dd>
                        </div>
                        <div>
                          <dt className="inline">{PLAN_LABELS[draftPlan]}の標準: </dt>
                          <dd className="inline text-ink">
                            {!inPlan ? "対象外" : rules[draftPlan]?.[f.key] ? "利用可" : "利用不可"}
                          </dd>
                        </div>
                        {f.prerequisites.length > 0 && (
                          <div className="sm:col-span-2">
                            <dt className="inline">前提条件: </dt>
                            <dd className="inline text-ink">{f.prerequisites.join("・")}</dd>
                          </div>
                        )}
                      </dl>
                      <p className="mt-2 text-sm text-ink">
                        現在の理由: {ENTITLEMENT_REASON_LABELS[f.reason]}
                      </p>
                    </div>
                  </div>

                  <fieldset>
                    <legend className="sr-only">{f.label}の個別設定</legend>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {MODES.map((m) => {
                        // 対象プランの外では、個別の許可・利用不可を新しく選べない(プランに従うへ戻すことはできる)。
                        const disabled = m !== "inherit" && !inPlan && f.override !== m;
                        return (
                          <label
                            key={m}
                            className={cn(
                              "flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                              disabled ? "cursor-not-allowed border-border bg-beige/50 text-ink-muted" : "cursor-pointer border-border bg-white text-ink",
                              draftOverride === m && "border-sage bg-sage-soft",
                            )}
                          >
                            <input
                              type="radio"
                              name={`override-${f.key}`}
                              value={m}
                              checked={draftOverride === m}
                              disabled={disabled || busy}
                              onChange={() => setDraftOverrides((d) => ({ ...d, [f.key]: m }))}
                              className="accent-sage"
                            />
                            {OVERRIDE_LABELS[m]}
                          </label>
                        );
                      })}
                    </div>
                    {!inPlan && (
                      <p className="mt-2 text-xs text-ink-muted">
                        {PLAN_LABELS[draftPlan]}の対象外のため、個別に許可・利用不可にできません
                        {draftOverride !== "inherit" ? "(残っている個別設定は効きません)" : ""}。
                      </p>
                    )}
                  </fieldset>

                  {changed && (
                    <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
                      保存すると: {accessLabel(after)}({ENTITLEMENT_REASON_LABELS[after.reason]})
                    </p>
                  )}
                </Card>
              );
            })}
          </section>
        );
      })}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-border bg-ivory/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Button type="button" disabled={!dirty || busy} onClick={() => setConfirming(true)}>
          変更を保存
        </Button>
        <Button type="button" variant="secondary" disabled={!dirty || busy} onClick={reset}>
          変更を取り消す
        </Button>
        <span className="text-xs text-ink-muted">{dirty ? "保存していない変更があります。" : "変更はありません。"}</span>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !pending) setConfirming(false);
            }}
            className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl focus:outline-none sm:rounded-2xl"
          >
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              変更内容の確認
            </h2>
            <p className="mt-1 text-sm text-ink-muted">次の内容で保存します。保存すると、サロンの画面とお客様用ページに反映されます。</p>
            <ul className="mt-4 flex flex-col gap-3">
              {summaries.map((s) => (
                <li key={s.title} className={cn("rounded-xl border p-3", s.revokes ? "border-warning/40 bg-warning-soft/40" : "border-border")}>
                  <p className="text-sm font-semibold text-ink">
                    {s.revokes && <span className="mr-1">【利用不可になります】</span>}
                    {s.title}
                  </p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-ink">
                    {s.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Label htmlFor="change-note">変更理由のメモ(任意・500文字まで)</Label>
              <textarea
                id="change-note"
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-greige bg-white px-3 py-2.5 text-base text-ink focus:border-sage focus:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
              />
              <p className="mt-1 text-xs text-ink-muted">メモは変更履歴に残ります(あとから編集・削除はできません)。</p>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <Button type="button" variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
                戻る
              </Button>
              <Button type="button" disabled={pending} onClick={save}>
                {pending ? "保存しています…" : "保存する"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
