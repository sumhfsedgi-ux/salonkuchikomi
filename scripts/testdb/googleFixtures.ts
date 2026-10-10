// Google 連携・予約通知の運用状態の testdb テスト用の部品。setupNotificationsTestEnv() のあとに使う。
// Google は擬似(lib/google/simulated.ts)。本物の Google・LINE へは接続しない。
import { createSimulatedGoogle, type SimulatedGoogle } from "@/lib/google/simulated";
import type { GoogleFlowDeps } from "@/lib/google/oauthFlow";
import type { GoogleFeature } from "@/lib/google/scopes";
import { notificationsTestAdminClient } from "./notificationsFixtures";

export const TEST_REDIRECT_URI = "http://localhost:3999/api/google/oauth/callback";

/** テストごとに別の Google アカウント(sub)を使うための番号。 */
export function uniqueSub(): string {
  return `3${Date.now()}${Math.floor(Math.random() * 1_000_000)}`.slice(0, 21);
}

export function createGoogleTestDeps(
  options: { reviewsEnabled?: boolean; extraUsers?: Array<{ sub: string; email: string }> } = {}
): { sim: SimulatedGoogle; deps: GoogleFlowDeps } {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const sim = createSimulatedGoogle({
    clientId,
    users: [
      { sub: "200000000000000000001", email: "owner-a@example.test" },
      { sub: "200000000000000000002", email: "owner-b@example.test" },
      { sub: "200000000000000000003", email: "reviews-only@example.test" },
      ...(options.extraUsers ?? []),
    ],
  });
  return {
    sim,
    deps: {
      transport: sim.transport,
      config: { clientId, clientSecret: "simulated-secret", redirectUri: TEST_REDIRECT_URI },
      reviewsEnabled: options.reviewsEnabled ?? true,
    },
  };
}

/** 開始 → 擬似 Google で許可 → コールバック、の1往復(必要なら prompt=consent の取り直しも1回たどる)。 */
export async function connectGoogle(params: {
  sim: SimulatedGoogle;
  deps: GoogleFlowDeps;
  salonId: string;
  userId: string;
  features: GoogleFeature[];
  sub: string;
  grantScopes?: string[];
  purpose?: "connect" | "add_scope" | "reauth" | "switch_account";
  expectedGoogleSub?: string | null;
  /** コールバックを受けるユーザー・店舗(途中でログアウト・切り替えが起きた場合を再現する)。 */
  callbackAs?: { salonId: string; userId: string };
}) {
  const { startGoogleConnect, completeGoogleConnect } = await import("@/lib/google/oauthFlow");
  let url = await startGoogleConnect(
    {
      salonId: params.salonId,
      userId: params.userId,
      features: params.features,
      purpose: params.purpose ?? "connect",
      expectedGoogleSub: params.expectedGoogleSub ?? null,
    },
    params.deps
  );
  for (let i = 0; i < 2; i++) {
    const { code, state } = params.sim.approve(url, { sub: params.sub, grantScopes: params.grantScopes });
    const result = await completeGoogleConnect(
      {
        salonId: params.callbackAs?.salonId ?? params.salonId,
        userId: params.callbackAs?.userId ?? params.userId,
        stateParam: state,
        code,
        oauthError: null,
      },
      params.deps
    );
    if (result.status !== "retry") return { result, url };
    url = result.url;
  }
  throw new Error("取り直しが2回以上続きました");
}

/** 旧サービスを使っていない店舗を、予約通知の稼働中にする(運用状態・機能の選択)。 */
export async function activateNonLegacy(salonId: string, mailFetchSince = new Date(Date.now() - 60 * 60 * 1000)) {
  const admin = notificationsTestAdminClient();
  await admin.from("salon_feature_selections").upsert(
    { salon_id: salonId, feature_key: "reservation_notifications", selected: true },
    { onConflict: "salon_id,feature_key" }
  );
  const { error } = await admin.from("reservation_notification_operations").upsert(
    {
      salon_id: salonId,
      state: "active",
      mail_fetch_since: mailFetchSince.toISOString(),
      mail_fetch_since_reason: "test",
      activated_at: new Date().toISOString(),
      activated_by: "test",
    },
    { onConflict: "salon_id" }
  );
  if (error) throw new Error(`運用状態を稼働中にできません: ${error.message}`);
}

/** テスト用の Google アカウントを直接作る(配信のテストで、Gmail 取得状況の行に使う)。 */
export async function createTestGoogleAccount(sub = `${Date.now()}${Math.floor(Math.random() * 1000)}`): Promise<string> {
  const { createGoogleAccount } = await import("@/lib/google/db/accounts");
  const account = await createGoogleAccount({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    googleSub: sub,
    email: `${sub}@example.test`,
    refreshToken: `refresh-${sub}`,
    grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
  });
  if (!account) throw new Error("Googleアカウントを作れません");
  return account.id;
}

export async function deleteTestGoogleAccounts(ids: string[]) {
  const admin = notificationsTestAdminClient();
  await admin.from("salon_google_bindings").delete().in("google_account_id", ids);
  await admin.from("google_accounts").delete().in("id", ids);
}
