"use client";

import { useState } from "react";
import type { OwnerSalon } from "@/lib/types";
import type { SurveyTemplateSummary } from "@/lib/supabase/queries";
import TemplatePicker from "@/components/admin/TemplatePicker";
import SalonDashboard from "@/components/admin/SalonDashboard";
import { createSalonAction, startSurveyAction } from "@/app/admin/(authed)/actions";
import { updateSalonAction } from "@/app/admin/(authed)/settings/actions";

const WIZARD_STEPS = [
  { step: 1, label: "店舗情報" },
  { step: 2, label: "テンプレート選択" },
  { step: 3, label: "質問確認" },
  { step: 4, label: "Google口コミURL" },
] as const;

interface Props {
  templates: SurveyTemplateSummary[];
  initialSalon: OwnerSalon | null;
  initialStep: 1 | 2;
  host: string;
}

export default function OnboardingWizard({
  templates,
  initialSalon,
  initialStep,
  host,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(initialStep);
  const [salon, setSalon] = useState<OwnerSalon | null>(initialSalon);

  const [name, setName] = useState(initialSalon?.name ?? "");
  const [slug, setSlug] = useState(initialSalon?.slug ?? "");
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [step1Saving, setStep1Saving] = useState(false);

  const [step2Error, setStep2Error] = useState<string | null>(null);

  const [googleReviewUrl, setGoogleReviewUrl] = useState("");
  const [step4Error, setStep4Error] = useState<string | null>(null);
  const [step4Saving, setStep4Saving] = useState(false);

  async function handleStep1Submit(e: React.FormEvent) {
    e.preventDefault();
    setStep1Saving(true);
    setStep1Error(null);
    const formData = new FormData();
    formData.set("name", name);
    formData.set("slug", slug);
    const result = await createSalonAction(formData);
    setStep1Saving(false);
    if (result.error || !result.salon) {
      setStep1Error(result.error ?? "登録に失敗しました。");
      return;
    }
    setSalon(result.salon);
    setStep(2);
  }

  async function handleTemplateSelect(templateId: string | null) {
    if (!salon) return;
    setStep2Error(null);
    const result = await startSurveyAction(salon.id, templateId);
    if (result.error) {
      setStep2Error(result.error);
      return;
    }
    setStep(3);
  }

  async function handleStep4Submit(e: React.FormEvent) {
    e.preventDefault();
    if (!salon) return;
    setStep4Saving(true);
    setStep4Error(null);
    const formData = new FormData();
    formData.set("google_review_url", googleReviewUrl);
    const result = await updateSalonAction(formData);
    setStep4Saving(false);
    if (result.error) {
      setStep4Error(result.error);
      return;
    }
    setSalon({ ...salon, googleReviewUrl });
    setStep(5);
  }

  if (step === 5 && salon) {
    return (
      <div className="flex flex-col gap-6">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
          設定が完了しました。お客様用URLをお使いください。
        </div>
        <SalonDashboard salon={salon} customerUrl={`${host}/review/${salon.slug}`} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">
          アンケートを作成しましょう
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          いくつかの項目を入力するだけで、お客様用の口コミ作成ページができあがります。
        </p>
      </div>

      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
        {WIZARD_STEPS.map((s) => (
          <li
            key={s.step}
            className={
              s.step === step
                ? "font-semibold text-slate-800"
                : s.step < step
                  ? "text-slate-500"
                  : "text-slate-300"
            }
          >
            STEP{s.step} {s.label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="max-w-xl rounded-xl border border-slate-200 bg-white p-6">
          <form onSubmit={handleStep1Submit} className="flex flex-col gap-5">
            <div>
              <label htmlFor="onboarding-name" className="mb-1 block text-sm font-medium text-slate-700">
                店舗名
              </label>
              <input
                id="onboarding-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="onboarding-slug" className="mb-1 block text-sm font-medium text-slate-700">
                ページURL
              </label>
              <p className="mb-1 text-xs text-slate-500">
                お客様用URLの一部になります。半角英数字とハイフンのみ使用できます（例: herb-salon-lumiere）。
              </p>
              <input
                id="onboarding-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </div>
            {step1Error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {step1Error}
              </div>
            )}
            <button
              type="submit"
              disabled={step1Saving}
              className="w-full rounded-lg bg-slate-800 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900 disabled:opacity-50 sm:w-auto sm:px-6"
            >
              {step1Saving ? "登録しています..." : "次へ"}
            </button>
          </form>
        </div>
      )}

      {step === 2 && (
        <div>
          <p className="mb-4 text-sm text-slate-600">
            業種に合わせたテンプレートから簡単に始められます。
          </p>
          <TemplatePicker templates={templates} onSelect={handleTemplateSelect} error={step2Error} />
        </div>
      )}

      {step === 3 && (
        <div className="max-w-xl rounded-xl border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-700">
            アンケートの質問が作成されました。内容はそのままでも使えますし、後から「アンケート設定」でいつでも自由に編集できます。
          </p>
          <button
            type="button"
            onClick={() => setStep(4)}
            className="mt-4 rounded-lg bg-slate-800 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900"
          >
            次へ
          </button>
        </div>
      )}

      {step === 4 && (
        <div className="max-w-xl rounded-xl border border-slate-200 bg-white p-6">
          <form onSubmit={handleStep4Submit} className="flex flex-col gap-5">
            <div>
              <label htmlFor="onboarding-google-url" className="mb-1 block text-sm font-medium text-slate-700">
                Google口コミ投稿URL
              </label>
              <p className="mb-1 text-xs text-slate-500">
                後から店舗設定でいつでも変更できます。
              </p>
              <input
                id="onboarding-google-url"
                type="url"
                value={googleReviewUrl}
                onChange={(e) => setGoogleReviewUrl(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </div>
            {step4Error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {step4Error}
              </div>
            )}
            <button
              type="submit"
              disabled={step4Saving}
              className="w-full rounded-lg bg-slate-800 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900 disabled:opacity-50 sm:w-auto sm:px-6"
            >
              {step4Saving ? "保存しています..." : "完了する"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
