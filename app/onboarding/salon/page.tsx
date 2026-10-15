import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getAccountState } from "@/lib/onboarding/accountState";
import { resolveNextStep } from "@/lib/onboarding/nextStep";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isShopRegistrationOpen, SHOP_REGISTRATION_CLOSED_TEXT } from "@/lib/onboarding/selfSignup";
import { getSupportContact } from "@/lib/support/contact";
import SalonProfileForm from "@/components/onboarding/SalonProfileForm";
import SupportContact from "@/components/support/SupportContact";
import Alert from "@/components/ui/Alert";
import Card from "@/components/ui/Card";

// 店舗の情報の入力(本人確認のあと・まだ店舗が無いとき)。登録すると「利用開始待ち」になる(登録しただけでは使えない)。
// 店舗があるアカウント(運営が登録した店舗に招待された人を含む)は、ここで新しい店舗を作らず、登録済みの店舗へ進む。
// 新規登録の受付が閉じている間は、入力の欄を出さず、受付停止の案内と問い合わせ先を出す(selfSignup.ts)。
export default async function OnboardingSalonPage() {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");
  const account = await getAccountState(supabase);
  const salon = account?.sessionTrusted ? await getCurrentSalon(supabase) : null;
  const next = resolveNextStep({ account, salon });
  if (next !== "/onboarding/salon") redirect(next);

  if (!(await isShopRegistrationOpen(getSupabaseAdmin()))) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-ink">店舗の登録</h1>
        <Alert variant="warning">{SHOP_REGISTRATION_CLOSED_TEXT}</Alert>
        <SupportContact contact={getSupportContact()} className="text-sm text-ink-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">新規登録 3/3</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">店舗の情報を入力してください</h1>
        <p className="mt-2 text-sm text-ink-muted">
          登録だけでは、料金のお支払いやご契約は発生しません。プランの選択・お支払いの手続きは、現在準備しています。
        </p>
      </div>
      <Card>
        <SalonProfileForm mode="create" loginEmail={user.email ?? ""} />
      </Card>
    </div>
  );
}
