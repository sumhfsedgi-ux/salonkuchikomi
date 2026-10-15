"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewRegistrationAction, registerSalonAction, saveDraftAction, type AccountPreview } from "@/app/ops/salons/drafts/actions";
import type { DraftFormValues } from "@/lib/ops/draftForm";
import { DRAFT_FIELD_ORDER } from "@/lib/ops/draftForm";
import { FEATURE_REGISTRY, type FeatureKey } from "@/lib/features/registry";
import { LIFECYCLE_LABELS, type OverrideMode } from "@/lib/features/entitlements";
import type { CatalogEntry, PlanRules } from "@/lib/ops/preview";
import { isSwitchOn, overrideForSwitch } from "@/lib/ops/toggle";
import { PLAN_LABELS } from "@/lib/ops/labels";
import { INVITATION_KIND_LABELS, usableFeatureLabels } from "@/lib/ops/onboardingDisplay";
import { REGISTRATION_KINDS, REGISTRATION_KIND_DESCRIPTIONS, REGISTRATION_KIND_LABELS, TEST_SEND_NOTICE } from "@/lib/onboarding/serviceStatus";
import type { SalonPlan } from "@/lib/access/plan";
import FormField, { fieldAria, focusFirstError } from "@/components/ui/FormField";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import ConfirmDialog, { ConfirmRow } from "@/components/ops/ConfirmDialog";
import { cn } from "@/lib/cn";

// 運営の「サロンを追加」(下書き → 内容の確認 → 登録して招待メールを送信)。
//   - 下書きを保存: サロン名だけで保存できる。アカウント・店舗は作らず、メールも送らない
//   - 内容を確認: 下書きを保存してから、本登録に足りない項目と、紐付け先のアカウント・送る案内を確認画面に出す
//   - 登録して招待メールを送信: 確認画面からだけ行う。結果は詳細の画面の「招待と案内」に出す
// 機能のスイッチは、すべての機能を出す。プランの対象外の機能は「プラン対象外」と出し、押せない。
// 登録種別は「通常登録」と「テスト用」だけ(新しい店舗は無料提供にできない)。通常登録のプランは「案内予定のプラン」(任意・契約ではない)、
// テスト用のプランは「契約プラン」(必須)。通常登録の店舗は、登録しただけでは使えない(利用開始は、将来のプラン選択・決済で行う)。

const SAVED_TEXT = "下書きを保存しました(アカウント・店舗はまだ作っていません。メールも送っていません)。";
const CATALOG_FEATURES = FEATURE_REGISTRY.filter((d) => d.entitlement === "catalog" && d.listed).sort((a, b) => a.sortOrder - b.sortOrder);

type Preview = { draftId: string; version: number; account: AccountPreview };

function accountText(a: AccountPreview): string {
  switch (a.kind) {
    case "new":
      return "新しいアカウントを作り、招待のメールを送ります。本人がメールのリンクからパスワードを設定します(運営はパスワードを作りません)。";
    case "unconfirmed":
      return "登録済みのアカウント(メールアドレスの確認がまだ)に紐付けます。今のパスワードは無効にし、本人が招待のメールのリンクから新しく設定します。";
    case "verified":
      return "登録済みのアカウント(本人確認済み)に紐付けます。パスワードは変えません。店舗が登録されたことと、ログイン先をお知らせします。";
    default:
      return "";
  }
}

function blockedText(a: Extract<AccountPreview, { kind: "blocked" }>): string {
  switch (a.reason) {
    case "has_salon":
      return "このメールアドレスのアカウントは、すでに店舗を持っています。新しい店舗は登録できません(1つのアカウントにつき1店舗)。";
    case "operator":
      return "このメールアドレスは運営管理のアカウントです。店舗の所有者にはできません。";
    case "unverified":
      return "このアカウントは本人確認が済んでいません。本人がログイン画面から本人確認を済ませると登録できます(パスワードを変えずに安全を保てないため)。";
    default:
      return "このメールアドレスのアカウントを特定できません。";
  }
}

export default function SalonDraftForm({
  initial,
  draftId,
  version: initialVersion,
  catalog,
  rules,
  arrival = null,
  savedAsComplimentary = false,
}: {
  initial: DraftFormValues;
  draftId: string | null;
  version: number | null;
  catalog: Partial<Record<FeatureKey, CatalogEntry>>;
  rules: PlanRules;
  /** 「サロンを追加」の画面から移ってきたとき: saved = 保存の結果を出す / confirm = 確認を開く */
  arrival?: "saved" | "confirm" | null;
  /** 0025 のときに「無料提供」で保存された下書き(登録種別を選び直してもらう)。 */
  savedAsComplimentary?: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<DraftFormValues>(initial);
  const [saved, setSaved] = useState<DraftFormValues>(initial);
  const [version, setVersion] = useState(initialVersion);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string; conflict?: boolean; existingSalonId?: string } | null>(
    arrival === "saved" ? { ok: true, text: SAVED_TEXT } : null,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [planNote, setPlanNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(saved), [values, saved]);
  const arrived = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // 「サロンを追加」の画面から移ってきた印(?saved=1 / ?confirm=1)は、すぐにアドレス欄から消す
  // (再読み込みで、もう一度確認を開かないように)。開発時の Strict Mode の2回目は何もしない。
  useEffect(() => {
    if (!arrival || arrived.current) return;
    arrived.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (arrival === "confirm") confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 最初の表示のときに1回だけ行う
  }, []);

  function set<K extends keyof DraftFormValues>(key: K, value: DraftFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setResult(null);
  }

  function changePlan(plan: "" | SalonPlan) {
    setValues((v) => {
      // 新しいプランの対象外になった機能の個別設定は外す(本登録でも、対象外の個別設定は登録しない)
      const kept: DraftFormValues["featureOverrides"] = {};
      const removed: string[] = [];
      for (const [k, mode] of Object.entries(v.featureOverrides) as Array<[FeatureKey, "allow" | "deny"]>) {
        if (plan && rules[plan]?.[k] !== undefined) kept[k] = mode;
        else removed.push(FEATURE_REGISTRY.find((d) => d.key === k)?.label ?? k);
      }
      setPlanNote(removed.length > 0 ? `プランの対象外になった機能(${removed.join("・")})の個別設定を外しました。` : null);
      return { ...v, plan, featureOverrides: kept };
    });
    setResult(null);
  }

  function applyErrors(errors: Record<string, string> | undefined) {
    setFieldErrors(errors ?? {});
    focusFirstError(DRAFT_FIELD_ORDER, errors ?? {}, (f) => `draft-${f}`);
  }

  function saveDraft() {
    setResult(null);
    startTransition(async () => {
      const res = await saveDraftAction({ draftId, expectedVersion: version, values: { ...values } });
      if (!res.ok) {
        applyErrors(res.fieldErrors);
        setResult({ ok: false, text: res.error ?? "入力内容をご確認ください。", conflict: res.conflict });
        return;
      }
      setFieldErrors({});
      setSaved(values);
      if (!draftId) {
        // 新しい下書き: 下書きの画面へ移り、そこで保存の結果を出す(アドレスと画面を一致させる)
        router.replace(`/ops/salons/drafts/${res.draftId}?saved=1`);
        return;
      }
      setVersion(res.version);
      setResult({ ok: true, text: SAVED_TEXT });
    });
  }

  function confirm() {
    setResult(null);
    startTransition(async () => {
      const res = await previewRegistrationAction({ draftId, expectedVersion: version, values: { ...values } });
      if (!draftId && res.draftId) {
        // 新しい下書き: 下書きの画面へ移り、そこで確認をもう一度開く(アドレスと画面を一致させる。
        // アドレスだけを書き換えると、Server Action のあとの再描画で別の画面に入れ替わり、確認が消える)
        setSaved(values);
        router.replace(`/ops/salons/drafts/${res.draftId}?confirm=1`);
        return;
      }
      if (res.ok) {
        setFieldErrors({});
        setSaved(values);
        setVersion(res.version);
        setPreview({ draftId: res.draftId, version: res.version, account: res.account });
        return;
      }
      if (res.draftId) {
        setSaved(values);
        if (res.version !== undefined) setVersion(res.version);
      }
      applyErrors(res.fieldErrors);
      setResult({ ok: false, text: res.error ?? "入力内容をご確認ください。", conflict: res.conflict });
    });
  }

  function register() {
    if (!preview) return;
    startTransition(async () => {
      const res = await registerSalonAction({ draftId: preview.draftId, expectedVersion: preview.version });
      if (!res.ok) {
        setPreview(null);
        applyErrors(res.fieldErrors);
        setResult({ ok: false, text: res.error, conflict: res.conflict, existingSalonId: res.existingSalonId });
        return;
      }
      const status = res.alreadyRegistered ? "already" : (res.notice?.status ?? "error");
      setSaved(values);
      router.push(`/ops/salons/${res.salonId}?registered=${encodeURIComponent(status)}#invitation`);
    });
  }

  const id = (f: string) => `draft-${f}`;
  const plan = values.plan || null;
  const overridesForPreview = Object.fromEntries(
    CATALOG_FEATURES.map((d) => [d.key, (values.featureOverrides[d.key] ?? "inherit") as OverrideMode]),
  ) as Partial<Record<FeatureKey, OverrideMode>>;
  const usableAfter = plan && values.serviceStatus ? usableFeatureLabels(catalog, rules, plan, overridesForPreview, values.serviceStatus) : [];
  const usableIfActive = plan ? usableFeatureLabels(catalog, rules, plan, overridesForPreview, "complimentary") : [];
  const isTest = values.serviceStatus === "test";
  // 通常登録のプランは「案内予定のプラン」(契約ではない)。テスト用では、登録のあとこのプランで利用を始める(契約プラン)。
  const planLabel = isTest ? "契約プラン" : "案内予定のプラン";

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
        className="flex flex-col gap-6"
        noValidate
        autoComplete="off"
      >
        <Card className="flex flex-col gap-5">
          <h2 className="text-base font-semibold text-ink">店舗とご担当者</h2>
          <FormField id={id("name")} label="サロン名" requirement="required" help="下書きは、サロン名だけで保存できます。" error={fieldErrors.name}>
            <Input id={id("name")} maxLength={100} autoComplete="off" value={values.name} onChange={(e) => set("name", e.target.value)} {...fieldAria(id("name"), { error: fieldErrors.name, help: true })} />
          </FormField>
          <FormField id={id("contactName")} label="担当者名" requirement="required" help="本登録に必要です。" error={fieldErrors.contactName}>
            <Input id={id("contactName")} maxLength={100} autoComplete="off" value={values.contactName} onChange={(e) => set("contactName", e.target.value)} {...fieldAria(id("contactName"), { error: fieldErrors.contactName, help: true })} />
          </FormField>
          <FormField id={id("businessType")} label="業種" requirement="optional" error={fieldErrors.businessType}>
            <Input id={id("businessType")} maxLength={100} autoComplete="off" value={values.businessType} onChange={(e) => set("businessType", e.target.value)} {...fieldAria(id("businessType"), { error: fieldErrors.businessType })} />
          </FormField>
          <FormField
            id={id("loginEmail")}
            label="ログイン用のメールアドレス"
            requirement="required"
            help="本登録に必要です。このアドレスに招待・ご案内のメールを送ります。"
            error={fieldErrors.loginEmail}
          >
            <Input
              id={id("loginEmail")}
              type="email"
              inputMode="email"
              autoComplete="off"
              maxLength={254}
              value={values.loginEmail}
              onChange={(e) => set("loginEmail", e.target.value)}
              {...fieldAria(id("loginEmail"), { error: fieldErrors.loginEmail, help: true })}
            />
          </FormField>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-ink">連絡用のメールアドレス</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="radio" name="contactEmailMode" checked={values.contactEmailMode === "same"} onChange={() => set("contactEmailMode", "same")} />
              ログイン用と同じ
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="radio" name="contactEmailMode" checked={values.contactEmailMode === "other"} onChange={() => set("contactEmailMode", "other")} />
              別のアドレスを使う
            </label>
            {values.contactEmailMode === "other" && (
              <FormField id={id("contactEmail")} label="連絡用のメールアドレス" requirement="required" error={fieldErrors.contactEmail}>
                <Input
                  id={id("contactEmail")}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  maxLength={254}
                  value={values.contactEmail}
                  onChange={(e) => set("contactEmail", e.target.value)}
                  {...fieldAria(id("contactEmail"), { error: fieldErrors.contactEmail })}
                />
              </FormField>
            )}
          </fieldset>
          <FormField id={id("contactPhone")} label="電話番号" requirement="optional" error={fieldErrors.contactPhone}>
            <Input id={id("contactPhone")} type="tel" inputMode="tel" autoComplete="off" maxLength={30} value={values.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} {...fieldAria(id("contactPhone"), { error: fieldErrors.contactPhone })} />
          </FormField>
        </Card>

        <Card className="flex flex-col gap-5">
          <h2 className="text-base font-semibold text-ink">登録種別とプラン</h2>
          <fieldset className="flex flex-col gap-2" aria-describedby={fieldErrors.serviceStatus ? id("serviceStatus-error") : undefined}>
            <legend className="mb-1 text-sm font-medium text-ink">
              登録種別
              <span className="ml-2 rounded bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger">必須</span>
            </legend>
            {savedAsComplimentary && !values.serviceStatus && (
              <Alert variant="warning">
                この下書きには「無料提供」が保存されていました。新しい店舗は無料提供にできないため、登録種別を選び直してください。
              </Alert>
            )}
            {REGISTRATION_KINDS.map((s) => (
              <label key={s} className="flex min-h-11 items-start gap-2 text-sm text-ink">
                <input
                  id={s === "pending" ? id("serviceStatus") : undefined}
                  type="radio"
                  name="serviceStatus"
                  className="mt-1"
                  checked={values.serviceStatus === s}
                  onChange={() => set("serviceStatus", s)}
                />
                <span>
                  <span className="font-medium">{REGISTRATION_KIND_LABELS[s]}</span>
                  <span className="block text-xs text-ink-muted">{REGISTRATION_KIND_DESCRIPTIONS[s]}</span>
                </span>
              </label>
            ))}
            {fieldErrors.serviceStatus && (
              <p id={id("serviceStatus-error")} className="text-sm text-danger">
                {fieldErrors.serviceStatus}
              </p>
            )}
          </fieldset>

          <FormField
            id={id("plan")}
            label={planLabel}
            requirement={isTest ? "required" : "optional"}
            help={
              isTest
                ? "テスト用の店舗の本登録に必要です。登録のあと、このプランで利用を始めます。"
                : "お客様に案内する予定のプランです。契約ではありません(契約プランは、お客様のプラン選択・お支払いの手続き(準備中)で決まります)。"
            }
            error={fieldErrors.plan}
          >
            <select
              id={id("plan")}
              value={values.plan}
              onChange={(e) => changePlan(e.target.value as "" | SalonPlan)}
              className="min-h-11 w-full rounded-lg border border-greige bg-white px-3 text-ink"
              {...fieldAria(id("plan"), { error: fieldErrors.plan, help: true })}
            >
              <option value="">{isTest ? "選んでください" : "未定"}</option>
              <option value="reviews">{PLAN_LABELS.reviews}</option>
              <option value="salonpack">{PLAN_LABELS.salonpack}</option>
            </select>
          </FormField>
          {planNote && <p className="text-sm text-warning" role="status">{planNote}</p>}
        </Card>

        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-ink">利用を許可する機能</h2>
            <p className="mt-1 text-sm text-ink-muted">
              プランの標準のまま使うか、個別に許可しない機能を選べます。プラン対象外・準備中・提供終了の機能は許可できません。
              プランが未定のときは設定できません。通常登録の店舗では、登録しただけでは許可した機能も使えません。
            </p>
          </div>
          {fieldErrors.features && <p className="text-sm text-danger">{fieldErrors.features}</p>}
          <ul className="flex flex-col gap-3">
            {CATALOG_FEATURES.map((d) => {
              const entry = catalog[d.key];
              const inPlan = Boolean(plan && rules[plan]?.[d.key] !== undefined);
              const available = entry?.lifecycle === "available";
              const defaultOn = plan ? (rules[plan]?.[d.key] ?? false) : false;
              const locked = !plan || !inPlan || !available;
              const override = (values.featureOverrides[d.key] ?? "inherit") as OverrideMode;
              const on = !locked && isSwitchOn(override, defaultOn);
              const state = !plan
                ? "プランを選ぶと設定できます"
                : !inPlan
                  ? "プラン対象外"
                  : !available
                    ? LIFECYCLE_LABELS[entry?.lifecycle ?? "coming_soon"]
                    : on
                      ? "利用を許可"
                      : "利用を許可しない";
              return (
                <li key={d.key} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{d.label}</p>
                    <p className="text-xs text-ink-muted" id={`${d.key}-state`}>
                      {state}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${d.label}の利用を許可する`}
                    aria-describedby={`${d.key}-state`}
                    disabled={locked || pending}
                    onClick={() => {
                      const next = overrideForSwitch(!on, defaultOn, "inherit");
                      setValues((v) => {
                        const overrides = { ...v.featureOverrides };
                        if (next === "inherit") delete overrides[d.key];
                        else overrides[d.key] = next;
                        return { ...v, featureOverrides: overrides };
                      });
                      setResult(null);
                    }}
                    className={cn(
                      "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 focus-visible:ring-offset-2",
                      on ? "border-sage bg-sage" : "border-greige bg-beige",
                      (locked || pending) && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition", on ? "translate-x-6" : "translate-x-1")} />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <div aria-live="polite" className="flex flex-col gap-2">
          {result && (
            <Alert variant={result.ok ? "success" : "error"}>
              {result.text}
              {result.existingSalonId && (
                <>
                  {" "}
                  <Link href={`/ops/salons/${result.existingSalonId}`} className="underline">
                    既存の店舗を開く
                  </Link>
                </>
              )}
              {result.conflict && (
                <>
                  {" "}
                  <button type="button" className="underline" onClick={() => window.location.reload()}>
                    再読み込み
                  </button>
                </>
              )}
            </Alert>
          )}
          {!result && dirty && <p className="text-sm text-warning">保存していない変更があります。</p>}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={saveDraft} disabled={pending || !dirty}>
            {pending ? "保存しています..." : "下書きを保存"}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "確認しています..." : "内容を確認(登録はまだしません)"}
          </Button>
          <Link
            href="/ops/salons"
            onClick={(e) => {
              if (dirty && !window.confirm("保存していない変更があります。一覧に戻りますか?")) e.preventDefault();
            }}
            className="text-sm text-ink-muted underline underline-offset-2"
          >
            一覧へ戻る
          </Link>
        </div>
      </form>

      {preview && (
        <ConfirmDialog
          title="登録の内容の確認"
          description="この内容で本登録し、案内のメールを送ります。登録すると、アカウントと店舗が作られます(下書きには戻せません)。"
          busy={pending}
          onClose={() => setPreview(null)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setPreview(null)} disabled={pending}>
                戻る
              </Button>
              <Button type="button" onClick={register} disabled={pending || preview.account.kind === "blocked"}>
                {pending ? "登録しています..." : "登録して招待メールを送信"}
              </Button>
            </>
          }
        >
          <dl className="flex flex-col gap-2">
            <ConfirmRow label="サロン名">{values.name}</ConfirmRow>
            <ConfirmRow label="担当者名">{values.contactName}</ConfirmRow>
            <ConfirmRow label="業種">{values.businessType || "—"}</ConfirmRow>
            <ConfirmRow label="連絡用メール">{values.contactEmailMode === "other" && values.contactEmail ? values.contactEmail : "ログイン用と同じ"}</ConfirmRow>
            <ConfirmRow label="電話番号">{values.contactPhone || "—"}</ConfirmRow>
            <ConfirmRow label="招待先">{values.loginEmail}</ConfirmRow>
            <ConfirmRow label="登録種別">{values.serviceStatus ? REGISTRATION_KIND_LABELS[values.serviceStatus] : "—"}</ConfirmRow>
            <ConfirmRow label={planLabel}>{plan ? `${PLAN_LABELS[plan]}${isTest ? "" : "(契約ではありません)"}` : "未定"}</ConfirmRow>
            <ConfirmRow label={isTest ? "利用を許可する機能" : "利用を始めたときに使える機能(予定)"}>
              {plan ? usableIfActive.join("・") || "なし" : "プランが未定のため、ありません"}
            </ConfirmRow>
          </dl>

          {preview.account.kind === "blocked" ? (
            <Alert variant="error">
              {blockedText(preview.account)}
              {preview.account.salonId && (
                <>
                  {" "}
                  <Link href={`/ops/salons/${preview.account.salonId}`} className="underline">
                    {preview.account.salonName ? `「${preview.account.salonName}」を開く` : "既存の店舗を開く"}
                  </Link>
                </>
              )}
            </Alert>
          ) : (
            <div className="flex flex-col gap-2 rounded-xl border border-border p-3 text-sm text-ink">
              <p className="font-semibold">紐付け先のアカウント</p>
              <p>{accountText(preview.account)}</p>
              <p>
                送る案内: {INVITATION_KIND_LABELS[preview.account.kind === "verified" ? "salon_notice" : "invite"]}
              </p>
            </div>
          )}

          <div className={cn("rounded-xl border p-3 text-sm", values.serviceStatus === "pending" ? "border-warning/40 bg-warning-soft/40" : "border-border")}>
            {values.serviceStatus === "pending" ? (
              <p>
                <span className="font-semibold">通常登録のため、登録のあとは「利用開始待ち」です。</span>
                登録しただけでは、サービスの機能は使えません。通常のお客様の利用開始は、プラン選択・お支払いの手続き(準備中)で行います。
              </p>
            ) : (
              <p>
                <span className="font-semibold">登録のあとに使える機能:</span> {usableAfter.join("・") || "ありません"}
              </p>
            )}
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-muted">
              <li>
                {preview.account.kind === "verified"
                  ? "担当者は本人確認が済んでいるため、いまのパスワードでログインできます。"
                  : "利用には、担当者の招待・本人確認の手続きの完了が必要です。"}
              </li>
              {values.serviceStatus !== "pending" && <li>予約通知は、Google・LINE の連携と開始の設定が完了するまで送信されません。</li>}
              {values.serviceStatus === "test" && <li>{TEST_SEND_NOTICE}</li>}
            </ul>
          </div>
          <p className="text-xs text-ink-muted">「送信を受け付けた」と表示されても、メールが届いた・読まれたという意味ではありません。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
