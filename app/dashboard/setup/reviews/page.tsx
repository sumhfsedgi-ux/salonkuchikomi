import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTemplates, getSurveyQuestionsWithOptions } from "@/lib/supabase/queries";
import { requireFeaturePage } from "@/lib/access/featureAccess";
import FeatureSuspended from "@/components/dashboard/FeatureSuspended";
import { getPlanExperience } from "@/lib/features/access";
import OnboardingWizard from "@/components/admin/OnboardingWizard";

// 口コミの初期設定(アンケートの作成 → 質問の確認 → Google口コミ投稿URL)。
// 完了済みなら、SalonPack はホーム、口コミプランは口コミの設定画面へ戻す(設定のやり直しを求めない)。
export const dynamic = "force-dynamic";

export default async function ReviewsSetupPage() {
  const supabase = await createClient();
  // 運営が口コミの利用を止めている店舗は、停止中の案内だけを出す(アンケート等は読まない・消さない)。
  const page = await requireFeaturePage(supabase, "reviews");
  if (page.status === "suspended") return <FeatureSuspended title="口コミ" />;
  const salon = page.salon;

  const { data: survey } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("is_active", true)
    .maybeSingle();

  if (survey && salon.onboardingCompleted) {
    redirect(getPlanExperience(salon.plan) === "reviews_direct" ? "/dashboard/reviews" : "/dashboard");
  }

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
