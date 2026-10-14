import { notFound, redirect } from "next/navigation";
import { requireOperator } from "@/lib/ops/operator";
import { getDraft, loadCatalogAndRules } from "@/lib/ops/onboardingQueries";
import type { DraftFormValues } from "@/lib/ops/draftForm";
import SalonDraftForm from "@/components/ops/SalonDraftForm";
import PageHeader from "@/components/ui/PageHeader";
import Badge from "@/components/ui/Badge";

// 下書きの編集・内容の確認・本登録(運営)。本登録の済んだ下書きは、登録した店舗の詳細へ移す。
export default async function OpsDraftPage({ params, searchParams }: PageProps<"/ops/salons/drafts/[id]">) {
  await requireOperator();
  const { id } = await params;
  // 「サロンを追加」の画面で下書きを作ったあとの続き(保存の結果を出す/確認を開く)
  const query = await searchParams;
  const arrival = query.confirm === "1" ? "confirm" : query.saved === "1" ? "saved" : null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const [draft, { catalog, rules }] = await Promise.all([getDraft(id), loadCatalogAndRules()]);
  if (!draft) notFound();
  if (draft.status === "registered" && draft.salonId) redirect(`/ops/salons/${draft.salonId}`);

  const initial: DraftFormValues = {
    name: draft.name,
    contactName: draft.contactName ?? "",
    loginEmail: draft.loginEmail ?? "",
    businessType: draft.businessType ?? "",
    contactEmailMode: draft.contactEmail ? "other" : "same",
    contactEmail: draft.contactEmail ?? "",
    contactPhone: draft.contactPhone ?? "",
    plan: draft.plan ?? "",
    serviceStatus: draft.serviceStatus ?? "",
    featureOverrides: draft.featureOverrides,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="サロンの下書き"
        description="下書きのあいだは、アカウント・店舗は作られず、メールも送られません。内容を確認してから本登録・招待します。"
        action={<Badge variant="neutral">下書き</Badge>}
      />
      <SalonDraftForm initial={initial} draftId={draft.id} version={draft.version} catalog={catalog} rules={rules} arrival={arrival} />
    </div>
  );
}
