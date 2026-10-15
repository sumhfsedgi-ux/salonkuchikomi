import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getTemplates, getActiveSurveyWithQuestions } from "@/lib/supabase/queries";
import { canAccessFeature, requireFeaturePage } from "@/lib/access/featureAccess";
import ReviewsSubNav from "@/components/reviews/ReviewsSubNav";
import { buttonClassName } from "@/components/ui/Button";
import NoFeaturesAvailable from "@/components/dashboard/NoFeaturesAvailable";
import QuestionEditor from "@/components/admin/QuestionEditor";
import RestartSurveyFromTemplate from "@/components/admin/RestartSurveyFromTemplate";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import GoogleReviewUrlForm from "@/components/admin/GoogleReviewUrlForm";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";

export default async function DashboardReviewsPage({ searchParams }: PageProps<"/dashboard/reviews">) {
  const supabase = await createClient();
  // 口コミを使えない口コミプランの店舗は、利用できる機能が無い旨だけを出す(アンケート等は読まない・消さない)。
  const page = await requireFeaturePage(supabase, "reviews");
  if (page.status === "no_features") return <NoFeaturesAvailable title="口コミ" />;
  const salon = page.salon;
  const params = await searchParams;

  const user = await getAuthedUser(supabase);
  const [survey, templates, inboxAllowed] = await Promise.all([
    getActiveSurveyWithQuestions(supabase, salon.id),
    getTemplates(supabase),
    user ? canAccessFeature(salon, user.id, "google_reviews") : Promise.resolve(false),
  ]);
  // アンケートがまだ無ければ、初期設定(アンケートの作成)へ進める。
  // 届いた口コミを使える店舗は、アンケートが無くても届いた口コミ・設定のタブを使えるので、移さずにタブの中で案内する。
  if (!survey && !inboxAllowed) redirect("/dashboard/setup/reviews");

  const headersList = await headers();
  const host = `${headersList.get("x-forwarded-proto") ?? "https"}://${headersList.get("host")}`;
  const customerUrl = `${host}/review/${salon.slug}`;

  return (
    <div className="flex flex-col gap-6">
      {/* 口コミプランは初期設定のあと、ホームではなくこの画面に来る(app/dashboard/actions.ts)。 */}
      {params?.onboarded === "1" && <Alert variant="success">設定が完了しました。お客様用URLをお使いください。</Alert>}
      <PageHeader title="口コミ" description="お客様が回答する質問や、口コミ投稿までの導線を設定できます。" />
      <ReviewsSubNav showInbox={inboxAllowed} />

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-ink">お客様用リンク</h2>

        {survey && (
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
        )}

        <Card>
          <GoogleReviewUrlForm initialUrl={salon.googleReviewUrl} />
        </Card>
      </div>

      {survey ? (
        <>
          <QuestionEditor key={survey.id} questions={survey.questions} />
          <RestartSurveyFromTemplate templates={templates} />
        </>
      ) : (
        <Card className="flex flex-col gap-3">
          <p className="font-medium text-ink">お客様が回答するアンケートを作成しましょう</p>
          <p className="text-sm text-ink-muted">アンケートを作成すると、お客様用口コミページから口コミの投稿まで案内できます。</p>
          <Link href="/dashboard/setup/reviews" className={buttonClassName({ size: "sm", className: "w-fit" })}>
            アンケートを作成する
          </Link>
        </Card>
      )}
    </div>
  );
}
