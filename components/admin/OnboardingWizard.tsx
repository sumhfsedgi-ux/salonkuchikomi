"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OwnerSalon } from "@/lib/types";
import type { SurveyTemplateSummary } from "@/lib/supabase/queries";
import TemplatePicker from "@/components/admin/TemplatePicker";
import QuestionEditor, { type QuestionData, type QuestionEditorHandle } from "@/components/admin/QuestionEditor";
import { createSalonAction, startSurveyAction, completeOnboardingAction } from "@/app/dashboard/actions";
import Card from "@/components/ui/Card";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import PageHeader from "@/components/ui/PageHeader";

// 初期設定の画面。2つの流れを持つ:
//   store_info     共通の店舗情報(全機能で共通。入力後、使う機能を選ぶ画面へ進む)
//   reviews_setup  口コミを選んだ店舗だけの設定(テンプレート → 質問 → Google口コミ投稿URL)
// どの機能の設定を案内するかはサーバー(lib/features)が決める。ブログだけ・予約通知だけの店舗には
// 口コミの設定を求めない。

const REVIEW_STEPS = [
  { step: 2, label: "テンプレート選択" },
  { step: 3, label: "質問確認" },
  { step: 4, label: "Google口コミURL" },
] as const;

interface StoreInfoProps {
  flow: "store_info";
}

interface ReviewsSetupProps {
  flow: "reviews_setup";
  templates: SurveyTemplateSummary[];
  salon: OwnerSalon;
  initialStep: 2 | 3;
  surveyId?: string;
  surveyQuestions?: QuestionData[];
}

type Props = StoreInfoProps | ReviewsSetupProps;

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

function StoreInfoStep() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const formData = new FormData();
    formData.set("name", name);
    formData.set("business_type", businessType);
    const result = await createSalonAction(formData);
    setSaving(false);
    if (result.error || !result.salon) {
      setError(result.error ?? "登録に失敗しました。");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="店舗情報を入力しましょう" description="入力したあと、使う機能を選んで、必要な設定だけを順に案内します。" />
      <Card className="max-w-xl">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div>
            <Label htmlFor="onboarding-name">店舗名</Label>
            <Input id="onboarding-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="onboarding-business-type">業種（任意）</Label>
            <Input
              id="onboarding-business-type"
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
              placeholder="例：ヘアサロン、エステサロン、整体院"
            />
          </div>
          {error && <Alert variant="error">{error}</Alert>}
          <Button type="submit" disabled={saving} fullWidth className="sm:w-auto sm:px-6">
            {saving ? "登録しています..." : "次へ"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function ReviewsSetup({ templates, salon, initialStep, surveyId, surveyQuestions = [] }: ReviewsSetupProps) {
  const [step, setStep] = useState<2 | 3 | 4>(initialStep);
  const [step2Error, setStep2Error] = useState<string | null>(null);
  const questionEditorRef = useRef<QuestionEditorHandle>(null);
  const [step3Error, setStep3Error] = useState<string | null>(null);
  const [step3Saving, setStep3Saving] = useState(false);
  const [googleReviewUrl, setGoogleReviewUrl] = useState("");
  const [step4Error, setStep4Error] = useState<string | null>(null);
  const [step4Saving, setStep4Saving] = useState(false);
  const router = useRouter();

  async function handleTemplateSelect(templateId: string | null) {
    setStep2Error(null);
    const result = await startSurveyAction(salon.id, templateId);
    if (result.error) {
      setStep2Error(result.error);
      return;
    }
    // 質問の一覧はサーバーで読み直す(テンプレートから作った質問を表示するため)。
    router.refresh();
    setStep(3);
  }

  async function handleStep3Continue() {
    setStep3Saving(true);
    setStep3Error(null);
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
    // 成功時はサーバー側で /dashboard?onboarded=1 へ移動するため、通常は戻ってこない。
    const result = await completeOnboardingAction(googleReviewUrl);
    setStep4Saving(false);
    if (result?.error) setStep4Error(result.error);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="アンケートを作成しましょう"
        description="いくつかの項目を入力するだけで、お客様用の口コミ作成ページができあがります。"
      />

      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
        {REVIEW_STEPS.map((s, i) => (
          <li
            key={s.step}
            className={s.step === step ? "font-semibold text-ink" : s.step < step ? "text-sage-dark" : "text-ink-muted/50"}
          >
            STEP{i + 1} {s.label}
          </li>
        ))}
      </ol>

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">業種に合わせたテンプレートから簡単に始められます。</p>
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
                  Googleビジネスプロフィール（Googleマップの管理画面）の「クチコミを増やす」機能から取得できるリンクを貼り付けてください。後から口コミでいつでも変更できます。
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

export default function OnboardingWizard(props: Props) {
  if (props.flow === "store_info") return <StoreInfoStep />;
  return <ReviewsSetup {...props} />;
}
