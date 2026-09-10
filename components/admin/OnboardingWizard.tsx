"use client";

import { useRef, useState } from "react";
import type { OwnerSalon } from "@/lib/types";
import type { SurveyTemplateSummary } from "@/lib/supabase/queries";
import TemplatePicker from "@/components/admin/TemplatePicker";
import QuestionEditor, { type QuestionData, type QuestionEditorHandle } from "@/components/admin/QuestionEditor";
import { createSalonAction, startSurveyAction, completeOnboardingAction } from "@/app/dashboard/actions";
import { updateSalonAction } from "@/app/dashboard/settings/actions";
import Card from "@/components/ui/Card";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import PageHeader from "@/components/ui/PageHeader";

const WIZARD_STEPS = [
  { step: 1, label: "店舗情報" },
  { step: 2, label: "テンプレート選択" },
  { step: 3, label: "質問確認" },
  { step: 4, label: "Google口コミURL" },
] as const;

interface Props {
  templates: SurveyTemplateSummary[];
  initialSalon: OwnerSalon | null;
  initialStep: 1 | 2 | 3;
  surveyId?: string;
  surveyQuestions?: QuestionData[];
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start text-sm font-medium text-ink-muted/70 transition hover:text-ink-muted"
    >
      ← 戻る
    </button>
  );
}

export default function OnboardingWizard({
  templates,
  initialSalon,
  initialStep,
  surveyId,
  surveyQuestions = [],
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(initialStep);
  const [salon, setSalon] = useState<OwnerSalon | null>(initialSalon);

  const [name, setName] = useState(initialSalon?.name ?? "");
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [step1Saving, setStep1Saving] = useState(false);

  const [step2Error, setStep2Error] = useState<string | null>(null);

  const questionEditorRef = useRef<QuestionEditorHandle>(null);
  const [step3Error, setStep3Error] = useState<string | null>(null);
  const [step3Saving, setStep3Saving] = useState(false);

  const [googleReviewUrl, setGoogleReviewUrl] = useState("");
  const [step4Error, setStep4Error] = useState<string | null>(null);
  const [step4Saving, setStep4Saving] = useState(false);

  async function handleStep1Submit(e: React.FormEvent) {
    e.preventDefault();
    setStep1Saving(true);
    setStep1Error(null);
    const formData = new FormData();
    formData.set("name", name);

    // Reaching STEP1 with a salon already set means the owner came back from
    // STEP2 to fix something -- update the existing row instead of inserting
    // a second one (an owner can only ever have one salon; a second insert
    // would break getCurrentSalon()'s single-row lookup for this account).
    if (salon) {
      const result = await updateSalonAction(formData);
      setStep1Saving(false);
      if (result.error) {
        setStep1Error(result.error);
        return;
      }
      setSalon({ ...salon, name });
      setStep(2);
      return;
    }

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

  async function handleStep3Continue() {
    setStep3Saving(true);
    setStep3Error(null);
    // Edits already auto-save in the background; this just makes sure the
    // very latest change is flushed before moving on.
    const result = await questionEditorRef.current?.saveAll();
    setStep3Saving(false);
    if (result?.error) {
      setStep3Error(result.error);
      return;
    }
    setStep(4);
  }

  async function handleStep4Submit(e: React.FormEvent) {
    e.preventDefault();
    setStep4Saving(true);
    setStep4Error(null);
    // On success this redirects server-side to /admin?onboarded=1, so this
    // call never resolves normally in the success case.
    const result = await completeOnboardingAction(googleReviewUrl);
    setStep4Saving(false);
    if (result?.error) {
      setStep4Error(result.error);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="アンケートを作成しましょう"
        description="いくつかの項目を入力するだけで、お客様用の口コミ作成ページができあがります。"
      />

      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
        {WIZARD_STEPS.map((s) => (
          <li
            key={s.step}
            className={
              s.step === step
                ? "font-semibold text-ink"
                : s.step < step
                  ? "text-sage-dark"
                  : "text-ink-muted/50"
            }
          >
            STEP{s.step} {s.label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card className="max-w-xl">
          <form onSubmit={handleStep1Submit} className="flex flex-col gap-5">
            <div>
              <Label htmlFor="onboarding-name">店舗名</Label>
              <Input
                id="onboarding-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            {step1Error && <Alert variant="error">{step1Error}</Alert>}
            <Button type="submit" disabled={step1Saving} fullWidth className="sm:w-auto sm:px-6">
              {step1Saving ? "登録しています..." : "次へ"}
            </Button>
          </form>
        </Card>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <BackButton onClick={() => setStep(1)} />
          <p className="text-sm text-ink-muted">
            業種に合わせたテンプレートから簡単に始められます。
          </p>
          <TemplatePicker templates={templates} onSelect={handleTemplateSelect} error={step2Error} />
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <BackButton onClick={() => setStep(2)} />
          <p className="text-sm text-ink-muted">
            お客様に聞く質問です。文字をタップして書き換えたり、＝を持って順番を入れ替えたりできます。
          </p>
          <QuestionEditor key={surveyId} ref={questionEditorRef} questions={surveyQuestions} />
          {step3Error && <Alert variant="error">{step3Error}</Alert>}
          <div className="flex items-center gap-4">
            <Button type="button" disabled={step3Saving} onClick={handleStep3Continue}>
              {step3Saving ? "確認しています..." : "次へ"}
            </Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="flex max-w-xl flex-col gap-4">
          <BackButton onClick={() => setStep(3)} />
          <Card>
            <form onSubmit={handleStep4Submit} className="flex flex-col gap-5">
              <div>
                <Label htmlFor="onboarding-google-url">Google口コミ投稿URL</Label>
                <p className="mb-1 text-xs text-ink-muted">
                  Googleビジネスプロフィール（Googleマップの管理画面）の「クチコミを増やす」機能から取得できるリンクを貼り付けてください。後から店舗設定でいつでも変更できます。
                </p>
                <Input
                  id="onboarding-google-url"
                  type="url"
                  value={googleReviewUrl}
                  onChange={(e) => setGoogleReviewUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
              {step4Error && <Alert variant="error">{step4Error}</Alert>}
              <Button type="submit" disabled={step4Saving} fullWidth className="sm:w-auto sm:px-6">
                {step4Saving ? "保存しています..." : "完了する"}
              </Button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
