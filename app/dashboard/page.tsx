import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { getPlanExperience, isFeatureIntroduced } from "@/lib/features/access";
import { loadSetupContext } from "@/lib/features/setupContext";
import { resolveFeatureStates } from "@/lib/features/featureState";
import { reviewsDirectDestination, toHomeCard } from "@/lib/features/homeCards";
import FeatureCard from "@/components/dashboard/FeatureCard";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import Alert from "@/components/ui/Alert";
import PageHeader from "@/components/ui/PageHeader";
import { ReviewIcon, BlogIcon, BellIcon, InboxIcon } from "@/components/ui/icons";

// ホーム兼、初期設定の入口(利用中の店舗だけ。店舗の登録・利用開始待ちは /onboarding)。
//   1. (店舗の情報は /onboarding/salon か運営の本登録で入力済み)
//   2. 口コミプランは機能一覧のホームを使わず、口コミの画面(未作成なら今まで通りの初期設定)へ直接進む
//   3. SalonPack は画面に出す全機能(registry の listed)をカードで並べる。契約外・準備中の機能も、説明を読めるようにグレーで紹介する
//      (利用権限は lib/features/access.ts。カードの種類は lib/features/homeCards.ts)
// お客様が使う機能を選ぶ仕組みは廃止した。ホームに表示しただけでは、予約通知は始まらない。

const ICONS = { reviews: ReviewIcon, blog: BlogIcon, reservation_notifications: BellIcon, google_reviews: InboxIcon } as const;

export default async function DashboardHomePage({ searchParams }: PageProps<"/dashboard">) {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  // 店舗が無い・利用開始待ちは layout が先に移す(ここに来るのは利用中の店舗だけ)。
  if (!salon) redirect("/onboarding/salon");

  const params = await searchParams;
  const justOnboarded = params?.onboarded === "1";

  if (getPlanExperience(salon.plan) === "reviews_direct") {
    // 行き先を決めるのに要るのは、有効なアンケートの有無だけ(機能ごとの状態は読まない)。
    const { data: survey, error } = await supabase.from("surveys").select("id").eq("salon_id", salon.id).eq("is_active", true).limit(1);
    if (error) throw new Error("アンケートの取得に失敗しました。");
    redirect(reviewsDirectDestination({ hasActiveSurvey: (survey ?? []).length > 0, onboardingCompleted: salon.onboardingCompleted, onboarded: justOnboarded }));
  }

  const { states } = resolveFeatureStates(await loadSetupContext(salon));
  const headersList = await headers();
  const host = `${headersList.get("x-forwarded-proto") ?? "https"}://${headersList.get("host")}`;
  const customerUrl = `${host}/review/${salon.slug}`;

  return (
    <div className="flex flex-col gap-6">
      {justOnboarded && <Alert variant="success">設定が完了しました。お客様用URLをお使いください。</Alert>}

      <PageHeader title="ホーム" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {states.filter((s) => isFeatureIntroduced({ definition: s.definition, status: s.access }, "feature_home", "home")).map((state) => {
          const card = toHomeCard(state);
          return (
            <FeatureCard
              key={state.key}
              icon={ICONS[state.key]}
              card={card}
              secondaryAction={state.key === "reviews" && card.kind === "available" ? <CopyUrlButton url={customerUrl} variant="link" /> : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
