import { requireOperator } from "@/lib/ops/operator";
import { loadCatalogAndRules } from "@/lib/ops/onboardingQueries";
import { EMPTY_DRAFT } from "@/lib/ops/draftForm";
import SalonDraftForm from "@/components/ops/SalonDraftForm";
import PageHeader from "@/components/ui/PageHeader";

// サロンを追加(運営)。最初の保存で下書きになる。下書きのあいだは、アカウント・店舗を作らず、メールも送らない。
export default async function OpsNewSalonPage() {
  await requireOperator();
  const { catalog, rules } = await loadCatalogAndRules();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="サロンを追加"
        description="下書きとして保存し、内容を確認してから本登録・招待します。下書きのあいだは、アカウント・店舗は作られず、メールも送られません。"
      />
      <SalonDraftForm initial={EMPTY_DRAFT} draftId={null} version={null} catalog={catalog} rules={rules} />
    </div>
  );
}
