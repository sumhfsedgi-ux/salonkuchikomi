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
// 将来のプランの選択・お支払いの手続きは、この画面に足す(今は仮の手続き・決済の処理を置かない)。
export default async function OnboardingStatusPage() {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");
  const account = await getAccountState(supabase);
  const salon = account?.sessionTrusted ? await getCurrentSalon(supabase) : null;
  const next = resolveNextStep({ account, salon });
  if (next !== "/onboarding/status" || !salon) redirect(next);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">お申し込みを受け付けました。利用開始のご案内をお待ちください。</h1>
        <p className="mt-2 text-sm text-ink-muted">
          運営で内容を確認し、利用開始のご案内をお送りします。ご契約・お支払いの手続きは、まだ発生していません。
          サービスの機能は、利用開始のあとにお使いいただけます。
        </p>
      </div>

      <Alert variant="warning">現在の状態: 利用開始待ち</Alert>

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
