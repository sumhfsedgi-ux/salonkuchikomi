import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon, getTemplates, getSurveyQuestionsWithOptions } from "@/lib/supabase/queries";
import { isReviewsOnly } from "@/lib/appMode";
import { isFeatureEnabledForPlan } from "@/lib/access/plan";
import OnboardingWizard from "@/components/admin/OnboardingWizard";
import FeatureCard from "@/components/dashboard/FeatureCard";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import Alert from "@/components/ui/Alert";
import PageHeader from "@/components/ui/PageHeader";
import { ReviewIcon, BlogIcon, BellIcon } from "@/components/ui/icons";

export default async function DashboardHomePage({
  searchParams,
}: PageProps<"/dashboard">) {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);

  if (!salon) {
    const templates = await getTemplates(supabase);
    return <OnboardingWizard templates={templates} initialSalon={null} initialStep={1} />;
  }

  const { data: survey } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!survey) {
    const templates = await getTemplates(supabase);
    return <OnboardingWizard templates={templates} initialSalon={salon} initialStep={2} />;
  }

  if (!salon.onboardingCompleted) {
    const surveyQuestions = await getSurveyQuestionsWithOptions(supabase, survey.id);
    return (
      <OnboardingWizard
        templates={[]}
        initialSalon={salon}
        initialStep={3}
        surveyId={survey.id}
        surveyQuestions={surveyQuestions}
      />
    );
  }

  // オンボーディング完了後、reviewsモード(APP_MODE=reviews)のデプロイでは常に
  // 口コミ管理画面へ直接転送する -- 3カードのホームグリッドは見せない。
  // ログイン後遷移の合流点はここ1箇所のみで、LoginForm/loginページ側の
  // redirect("/dashboard")は変更不要(PLAN参照)。
  if (isReviewsOnly()) redirect("/dashboard/reviews");

  const params = await searchParams;
  const justOnboarded = params?.onboarded === "1";

  // Only what Home actually needs to render: the salon's name (already
  // fetched above) and the customer URL (cheap, no extra query). No review
  // history / blog posts / notification history are fetched here -- those
  // belong to their own /dashboard/reviews, /dashboard/blog,
  // /dashboard/notifications pages, fetched only when each is opened.
  const headersList = await headers();
  const host = `${headersList.get("x-forwarded-proto") ?? "https"}://${headersList.get("host")}`;
  const customerUrl = `${host}/review/${salon.slug}`;

  return (
    <div className="flex flex-col gap-6">
      {justOnboarded && (
        <Alert variant="success">設定が完了しました。お客様用URLをお使いください。</Alert>
      )}

      <PageHeader title="ホーム" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FeatureCard
          icon={ReviewIcon}
          title="口コミ"
          description="Google口コミ作成をかんたんに"
          status="active"
          href="/dashboard/reviews"
          ctaLabel="口コミを使う"
          secondaryAction={<CopyUrlButton url={customerUrl} variant="link" />}
        />
        {/* ブログ・予約通知は店舗の契約プランで使える場合のみ表示する
            (このカード表示自体はあくまで見た目の出し分けで、実際のアクセス
            制御は各ページ/Server Actionのrequire FeatureAccess()が担う)。 */}
        {isFeatureEnabledForPlan(salon.plan, "blog") && (
          <FeatureCard
            icon={BlogIcon}
            title="ブログ"
            description="Hot PepperブログをAIで作成"
            status="active"
            href="/dashboard/blog"
            ctaLabel="ブログを作る"
          />
        )}
        {isFeatureEnabledForPlan(salon.plan, "notifications") && (
          <FeatureCard
            icon={BellIcon}
            title="予約通知"
            description="予約をLINEで自動通知"
            status="active"
            href="/dashboard/notifications"
            ctaLabel="詳しく見る"
          />
        )}
      </div>
    </div>
  );
}
