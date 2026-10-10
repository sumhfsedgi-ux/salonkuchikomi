import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon, getTemplates, getSurveyQuestionsWithOptions } from "@/lib/supabase/queries";
import OnboardingWizard from "@/components/admin/OnboardingWizard";

// 口コミを選んだ店舗の初期設定(アンケートの作成 → 質問の確認 → Google口コミ投稿URL)。
// 完了済みならホームへ戻す(設定のやり直しを求めない)。
export const dynamic = "force-dynamic";

export default async function ReviewsSetupPage() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  const { data: survey } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("is_active", true)
    .maybeSingle();

  if (survey && salon.onboardingCompleted) redirect("/dashboard");

  if (!survey) {
    const templates = await getTemplates(supabase);
    return <OnboardingWizard flow="reviews_setup" templates={templates} salon={salon} initialStep={2} />;
  }

  const surveyQuestions = await getSurveyQuestionsWithOptions(supabase, survey.id);
  return (
    <OnboardingWizard
      flow="reviews_setup"
      templates={[]}
      salon={salon}
      initialStep={3}
      surveyId={survey.id}
      surveyQuestions={surveyQuestions}
    />
  );
}
