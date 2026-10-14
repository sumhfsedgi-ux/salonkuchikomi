"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { registerOwnSalonAction, updateRegistrationAction } from "@/app/onboarding/actions";
import FormField, { fieldAria, focusFirstError } from "@/components/ui/FormField";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

export interface SalonProfileValues {
  name: string;
  contactName: string;
  businessType: string;
  contactEmailMode: "same" | "other";
  contactEmail: string;
  contactPhone: string;
}

const FIELD_ORDER = ["name", "contactName", "businessType", "contactEmail", "contactPhone"] as const;

// お客様の店舗の情報(登録・修正)。必須・任意を見出しに出し、誤りは欄の近くに出す。
// 連絡用のメールは「ログイン用と同じ」を初期値にし、違う場合だけ入力する。
export default function SalonProfileForm({
  mode,
  loginEmail,
  initial,
  contactOnly = false,
}: {
  mode: "create" | "edit";
  loginEmail: string;
  initial?: Partial<SalonProfileValues>;
  /** 担当者・連絡先だけを出す(サロン設定の画面。店舗名・業種は既存の欄で編集する。値はそのまま送る)。 */
  contactOnly?: boolean;
}) {
  const start: SalonProfileValues = useMemo(
    () => ({
      name: initial?.name ?? "",
      contactName: initial?.contactName ?? "",
      businessType: initial?.businessType ?? "",
      contactEmailMode: initial?.contactEmailMode ?? "same",
      contactEmail: initial?.contactEmail ?? "",
      contactPhone: initial?.contactPhone ?? "",
    }),
    [initial],
  );
  const [values, setValues] = useState<SalonProfileValues>(start);
  const [saved, setSaved] = useState<SalonProfileValues>(start);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function set<K extends keyof SalonProfileValues>(key: K, value: SalonProfileValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setResult(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      const res = mode === "create" ? await registerOwnSalonAction({ ...values }) : await updateRegistrationAction({ ...values });
      if (!res.ok) {
        setFieldErrors(res.fieldErrors ?? {});
        if (res.error) setResult({ ok: false, text: res.error });
        else setResult({ ok: false, text: "入力内容をご確認ください。" });
        focusFirstError(FIELD_ORDER, res.fieldErrors ?? {}, (f) => `profile-${f}`);
        return;
      }
      setFieldErrors({});
      setSaved(values);
      if (mode === "create") {
        window.location.replace("/onboarding/status");
        return;
      }
      setResult({ ok: true, text: "登録内容を保存しました。" });
    });
  }

  const id = (f: string) => `profile-${f}`;

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      {!contactOnly && (
      <FormField id={id("name")} label="サロン名" requirement="required" error={fieldErrors.name}>
        <Input
          id={id("name")}
          autoComplete="organization"
          maxLength={100}
          required
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          {...fieldAria(id("name"), { error: fieldErrors.name })}
        />
      </FormField>
      )}
      {contactOnly && fieldErrors.name && <Alert variant="error">店舗名は、上の「サロン設定」で入力してください。</Alert>}
      <FormField id={id("contactName")} label="担当者名" requirement="required" error={fieldErrors.contactName}>
        <Input
          id={id("contactName")}
          autoComplete="name"
          maxLength={100}
          required
          value={values.contactName}
          onChange={(e) => set("contactName", e.target.value)}
          {...fieldAria(id("contactName"), { error: fieldErrors.contactName })}
        />
      </FormField>
      {!contactOnly && (
      <FormField id={id("businessType")} label="業種" requirement="optional" help="例: エステ・ネイル・美容室" error={fieldErrors.businessType}>
        <Input
          id={id("businessType")}
          maxLength={100}
          value={values.businessType}
          onChange={(e) => set("businessType", e.target.value)}
          {...fieldAria(id("businessType"), { error: fieldErrors.businessType, help: true })}
        />
      </FormField>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">連絡用のメールアドレス</legend>
        <label className="flex min-h-11 items-start gap-2 text-sm text-ink">
          <input
            type="radio"
            name="contactEmailMode"
            className="mt-1"
            checked={values.contactEmailMode === "same"}
            onChange={() => set("contactEmailMode", "same")}
          />
          <span className="[overflow-wrap:anywhere]">ログイン用と同じ({loginEmail})</span>
        </label>
        <label className="flex min-h-11 items-start gap-2 text-sm text-ink">
          <input
            type="radio"
            name="contactEmailMode"
            className="mt-1"
            checked={values.contactEmailMode === "other"}
            onChange={() => set("contactEmailMode", "other")}
          />
          <span>別のアドレスを使う</span>
        </label>
        {values.contactEmailMode === "other" && (
          <FormField id={id("contactEmail")} label="連絡用のメールアドレス" requirement="required" error={fieldErrors.contactEmail}>
            <Input
              id={id("contactEmail")}
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={254}
              value={values.contactEmail}
              onChange={(e) => set("contactEmail", e.target.value)}
              {...fieldAria(id("contactEmail"), { error: fieldErrors.contactEmail })}
            />
          </FormField>
        )}
      </fieldset>

      <FormField id={id("contactPhone")} label="電話番号" requirement="optional" help="例: 03-1234-5678" error={fieldErrors.contactPhone}>
        <Input
          id={id("contactPhone")}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={30}
          value={values.contactPhone}
          onChange={(e) => set("contactPhone", e.target.value)}
          {...fieldAria(id("contactPhone"), { error: fieldErrors.contactPhone, help: true })}
        />
      </FormField>

      <div aria-live="polite">
        {result && <Alert variant={result.ok ? "success" : "error"}>{result.text}</Alert>}
        {!result && dirty && mode === "edit" && (
          <p className="text-sm text-warning">保存していない変更があります。</p>
        )}
      </div>

      <Button type="submit" disabled={pending || (mode === "edit" && !dirty)} fullWidth>
        {pending ? "保存しています..." : mode === "create" ? "店舗を登録する" : "登録内容を保存する"}
      </Button>
    </form>
  );
}
