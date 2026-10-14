import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getAccountState } from "@/lib/onboarding/accountState";
import { resolveNextStep } from "@/lib/onboarding/nextStep";
import SalonProfileForm from "@/components/onboarding/SalonProfileForm";
import Card from "@/components/ui/Card";

// 店舗の情報の入力(本人確認のあと・まだ店舗が無いとき)。登録すると「利用開始待ち」になる。
// 店舗があるアカウント(運営が登録した店舗に招待された人を含む)は、ここで新しい店舗を作らず、登録済みの店舗へ進む。
export default async function OnboardingSalonPage() {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");
  const account = await getAccountState(supabase);
  const salon = account?.sessionTrusted ? await getCurrentSalon(supabase) : null;
  const next = resolveNextStep({ account, salon });
  if (next !== "/onboarding/salon") redirect(next);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">新規登録 3/3</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">店舗の情報を入力してください</h1>
        <p className="mt-2 text-sm text-ink-muted">
          登録が済むと、運営で内容を確認し、利用開始のご案内をお送りします。料金のお支払いやご契約は、この段階では発生しません。
        </p>
      </div>
      <Card>
        <SalonProfileForm mode="create" loginEmail={user.email ?? ""} />
      </Card>
    </div>
  );
}
