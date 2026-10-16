import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getAccountState } from "@/lib/onboarding/accountState";
import { resolveNextStep } from "@/lib/onboarding/nextStep";
import { getSupportContact } from "@/lib/support/contact";
import SalonProfileForm from "@/components/onboarding/SalonProfileForm";
import SupportContact from "@/components/support/SupportContact";
import Alert from "@/components/ui/Alert";
import Card from "@/components/ui/Card";

// 利用開始待ち。できるのは、登録内容の確認・修正と、ログアウトだけ(サービスの機能は使えない)。
// 通常のお客様は、将来、この画面のプランの選択・お支払いの手続きで利用を始める(運営の承認では始めない)。
// 今は手続きが無いため、仮の手続き・決済の処理・支払い済みの印は置かず、準備中であることだけを伝える。
// 承認や、送る仕組みの無い通知(利用開始のご案内など)は約束しない。止めている既存の店舗には、別の文を出す。
export default async function OnboardingStatusPage() {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");
  const account = await getAccountState(supabase);
  const salon = account?.sessionTrusted ? await getCurrentSalon(supabase) : null;
  const next = resolveNextStep({ account, salon });
  if (next !== "/onboarding/status" || !salon) redirect(next);
  const existing = salon.registrationSource === "existing";

  return (
    <div className="flex flex-col gap-6">
      {existing ? (
        <div>
          <h1 className="text-xl font-semibold text-ink">現在、この店舗ではサービスをご利用いただけません</h1>
          <p className="mt-2 text-sm text-ink-muted">運営にお問い合わせください。ご登録内容の確認・修正はできます。</p>
        </div>
      ) : (
        <div>
          <h1 className="text-xl font-semibold text-ink">店舗情報の登録が完了しました</h1>
          <p className="mt-2 text-sm text-ink-muted">
            現在、プラン選択・お支払いの手続きを準備しています。手続きができるようになるまで、サービスの機能はご利用いただけません。
            ご契約・お支払いは、まだ発生していません。
          </p>
        </div>
      )}

      <Alert variant="warning">現在の状態: {existing ? "ご利用いただけない状態" : "ご利用開始前"}</Alert>

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink">ご登録内容</h2>
          <p className="mt-1 text-sm text-ink-muted [overflow-wrap:anywhere]">ログイン用のメールアドレス: {user.email}</p>
        </div>
        <SalonProfileForm
          mode="edit"
          loginEmail={user.email ?? ""}
          initial={{
            name: salon.name,
            contactName: salon.contactName ?? "",
            businessType: salon.businessType ?? "",
            contactEmailMode: salon.contactEmail ? "other" : "same",
            contactEmail: salon.contactEmail ?? "",
            contactPhone: salon.contactPhone ?? "",
          }}
        />
      </Card>

      <div className="text-sm text-ink-muted">
        <p>ご不明な点は、運営までお問い合わせください。</p>
        <SupportContact contact={getSupportContact()} className="mt-1 text-sm text-ink-muted" />
      </div>
    </div>
  );
}
