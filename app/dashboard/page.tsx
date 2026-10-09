import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { isReviewsOnly } from "@/lib/appMode";
import { loadSetupContext } from "@/lib/features/setupContext";
import { buildSetupChecklist, resolveFeatureStates, type FeatureState } from "@/lib/features/featureState";
import { toFeatureOptions } from "@/lib/features/viewModel";
import OnboardingWizard from "@/components/admin/OnboardingWizard";
import FeatureCard from "@/components/dashboard/FeatureCard";
import FeatureSelectionForm from "@/components/features/FeatureSelectionForm";
import CopyUrlButton from "@/components/admin/CopyUrlButton";
import Alert from "@/components/ui/Alert";
import Card from "@/components/ui/Card";
import PageHeader from "@/components/ui/PageHeader";
import { ReviewIcon, BlogIcon, BellIcon } from "@/components/ui/icons";

// ホーム兼、初期設定の入口。
//   1. 店舗が無ければ、共通の店舗情報だけを入力する
//   2. 使う機能をまだ選んでいなければ(既存の利用の形跡も無ければ)、契約上使える機能から複数選ぶ
//   3. それ以外は、選んだ機能の「未設定の項目だけ」を案内し、機能のカードを並べる
// 既存の店舗は利用の形跡から選択を推定するため、初期設定のやり直しを求めない。
// Google に接続したり初期設定を終えたりしただけでは、予約通知は始まらない(lib/features/featureState.ts)。

const ICONS = { reviews: ReviewIcon, blog: BlogIcon, reservation_notifications: BellIcon, google_reviews: ReviewIcon } as const;
const CTA = { reviews: "口コミを使う", blog: "ブログを作る", reservation_notifications: "詳しく見る", google_reviews: "設定を見る" } as const;

function reviewsSetupIncomplete(state: FeatureState | undefined): boolean {
  return Boolean(state?.selected && state.setupItems.some((i) => i.key === "review_survey" && !i.complete));
}

export default async function DashboardHomePage({ searchParams }: PageProps<"/dashboard">) {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return <OnboardingWizard flow="store_info" />;

  const ctx = await loadSetupContext(salon);
  const { states, selectionSource } = resolveFeatureStates(ctx);

  if (selectionSource === "none") {
    return (
      <div className="flex max-w-xl flex-col gap-6">
        <PageHeader title="使う機能を選びましょう" description="ご契約の範囲で使える機能です。選んだ機能に必要な設定だけを順に案内します。" />
        <Card>
          <FeatureSelectionForm options={toFeatureOptions(states)} submitLabel="次へ" afterSave="/dashboard" />
        </Card>
      </div>
    );
  }

  const selected = states.filter((s) => s.selected);
  const reviews = states.find((s) => s.key === "reviews");
  // 口コミだけを使う店舗は、今まで通りアンケートの作成へそのまま進む。
  if (selected.length === 1 && reviewsSetupIncomplete(reviews)) redirect("/dashboard/setup/reviews");
  if (isReviewsOnly() && !reviewsSetupIncomplete(reviews)) redirect("/dashboard/reviews");

  const params = await searchParams;
  const justOnboarded = params?.onboarded === "1";
  const checklist = buildSetupChecklist(states);
  const addable = states.filter((s) => !s.selected && s.status === "not_selected");

  const headersList = await headers();
  const host = `${headersList.get("x-forwarded-proto") ?? "https"}://${headersList.get("host")}`;
  const customerUrl = `${host}/review/${salon.slug}`;

  return (
    <div className="flex flex-col gap-6">
      {justOnboarded && <Alert variant="success">設定が完了しました。お客様用URLをお使いください。</Alert>}

      <PageHeader title="ホーム" />

      {checklist.length > 0 && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ink">設定が必要な項目</h2>
          <ul className="flex flex-col gap-2">
            {checklist.map((item) => (
              <li key={item.key} className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm text-ink">
                  {item.label}
                  <span className="ml-2 text-xs text-ink-muted">({item.features.join("・")}{item.required ? "" : "・推奨"})</span>
                </span>
                <Link href={item.href} className="text-sm text-sage-dark underline underline-offset-2">
                  設定する
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {selected.length === 0 ? (
        <Card className="text-sm text-ink-muted">
          利用する機能が選択されていません。
          <Link href="/dashboard/settings" className="ml-1 text-sage-dark underline underline-offset-2">
            サロン設定
          </Link>
          の「利用する機能」から選べます。
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {selected.map((state) => (
            <FeatureCard
              key={state.key}
              icon={ICONS[state.key]}
              title={state.definition.label}
              description={state.message ?? state.definition.description}
              status="active"
              href={state.definition.href}
              ctaLabel={CTA[state.key]}
              secondaryAction={state.key === "reviews" ? <CopyUrlButton url={customerUrl} variant="link" /> : undefined}
            />
          ))}
        </div>
      )}

      {addable.length > 0 && (
        <p className="text-sm text-ink-muted">
          追加できる機能:{addable.map((s) => s.definition.label).join("・")}(
          <Link href="/dashboard/settings" className="text-sage-dark underline underline-offset-2">
            利用する機能
          </Link>
          から追加できます)
        </p>
      )}
    </div>
  );
}
