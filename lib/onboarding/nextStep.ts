import type { AccountState } from "@/lib/onboarding/accountState";
import { isServiceActive, type ServiceStatus } from "@/lib/onboarding/serviceStatus";

// ログイン・メールのリンクのあと、また各画面の入口で、次に進む場所を決める(DBに触れない)。
// ログイン → 本人確認 → 店舗の登録 → 利用開始 の順に、まだ済んでいない最初の段階へ進める(途中で離れても、ここから再開する)。
//   1. 運営の管理者(信頼できるセッション) ........ /ops/salons(店舗の登録・初期設定には進まない)
//   2. 信頼できないセッション ...................... /auth/verify(本人確認。済んでいるのに古いセッションなら、ログインし直しを案内)
//   3. 店舗が無い .................................. /onboarding/salon
//   4. 利用開始待ち ................................ /onboarding/status
//   5. それ以外 .................................... /dashboard(既存の初期設定の案内へ)

export type NextStep = "/login" | "/ops/salons" | "/auth/verify" | "/onboarding/salon" | "/onboarding/status" | "/dashboard";

export function resolveNextStep(input: {
  account: AccountState | null;
  salon: { serviceStatus: ServiceStatus } | null;
}): NextStep {
  const { account, salon } = input;
  if (!account) return "/login";
  if (account.isOperator && account.sessionTrusted) return "/ops/salons";
  if (!account.sessionTrusted) return "/auth/verify";
  if (!salon) return "/onboarding/salon";
  if (!isServiceActive(salon.serviceStatus)) return "/onboarding/status";
  return "/dashboard";
}
