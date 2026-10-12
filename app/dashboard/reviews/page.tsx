import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTemplates, getActiveSurveyWithQuestions } from "@/lib/supabase/queries";
import { requireFeatureAccess } from "@/lib/access/featureAccess";
import QuestionEditor from "@/components/admin/QuestionEditor";
import RestartSurveyFromTemplate from "@/components/admin/RestartSurveyFromTemplate";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import GoogleReviewUrlForm from "@/components/admin/GoogleReviewUrlForm";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";

export default async function DashboardReviewsPage({ searchParams }: PageProps<"/dashboard/reviews">) {
  const supabase = await createClient();
  const salon = await requireFeatureAccess(supabase, "reviews");
  const params = await searchParams;

  const [survey, templates] = await Promise.all([
    getActiveSurveyWithQuestions(supabase, salon.id),
    getTemplates(supabase),
  ]);
  // アンケートがまだ無ければ、初期設定(アンケートの作成)へ進める。
  if (!survey) redirect("/dashboard/setup/reviews");

  const headersList = await headers();
  const host = `${headersList.get("x-forwarded-proto") ?? "https"}://${headersList.get("host")}`;
  const customerUrl = `${host}/review/${salon.slug}`;

  return (
    <div className="flex flex-col gap-6">
      {/* 口コミプランは初期設定のあと、ホームではなくこの画面に来る(app/dashboard/actions.ts)。 */}
      {params?.onboarded === "1" && <Alert variant="success">設定が完了しました。お客様用URLをお使いください。</Alert>}
      <PageHeader title="口コミ" description="お客様が回答する質問や、口コミ投稿までの導線を設定できます。" />

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-ink">お客様用リンク</h2>

        <Card>
          <p className="font-medium text-ink">お客様用口コミページ</p>
          <p className="mt-1 text-sm text-ink-muted">
            施術後にLINEやDMで送るページです。
          </p>
          <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 truncate rounded-lg bg-ivory px-3 py-2.5 text-sm text-ink">
              {customerUrl}
            </div>
            <CopyUrlButton url={customerUrl} />
          </div>
        </Card>

        <Card>
          <GoogleReviewUrlForm initialUrl={salon.googleReviewUrl} />
        </Card>
      </div>

      <QuestionEditor key={survey.id} questions={survey.questions} />
      <RestartSurveyFromTemplate templates={templates} />
    </div>
  );
}
