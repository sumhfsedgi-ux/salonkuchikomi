// 予約通知のtestdbテスト用フィクスチャ。setupNotificationsTestEnv()で
// process.envをテスト用プロジェクトへ切り替えた後に使うこと。
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("setupNotificationsTestEnv()を先に呼んでください。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface TestSalonFixture {
  userId: string;
  salonId: string;
  email: string;
  password: string;
  /** 削除する(authユーザー削除がsalons/line_connections/notification_*へcascadeする)。 */
  cleanup: () => Promise<void>;
}

/** テスト専用のsalon(=authユーザー1人+profiles+salons)を1つ作る。 */
export async function createTestSalon(options?: { plan?: "reviews" | "salonpack" }): Promise<TestSalonFixture> {
  const supabase = adminClient();
  const email = `notif-testdb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
  const password = `Test${Math.random().toString(36).slice(2, 12)}!9`;

  const { data: userData, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) throw new Error(`テストユーザー作成に失敗: ${userError?.message}`);
  const userId = userData.user.id;

  // handle_new_user()トリガー(0002)がprofilesを自動作成するまで少し待つ必要は
  // 基本的に無い(同一トランザクション内のトリガーのため)が、念のため確認する。
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError || !profile) {
    await supabase.auth.admin.deleteUser(userId);
    throw new Error(`profiles行の自動作成を確認できません: ${profileError?.message}`);
  }

  const slug = `notif-testdb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { data: salon, error: salonError } = await supabase
    .from("salons")
    .insert({ owner_id: profile.id, name: "テストDB検証用サロン", slug, plan: options?.plan ?? "salonpack" })
    .select("id")
    .single();
  if (salonError || !salon) {
    await supabase.auth.admin.deleteUser(userId);
    throw new Error(`salons行の作成に失敗: ${salonError?.message}`);
  }

  return {
    userId,
    salonId: salon.id,
    email,
    password,
    cleanup: async () => {
      await supabase.auth.admin.deleteUser(userId);
    },
  };
}

/** ブラウザと同じ権限(anon キー)のクライアント。ログインしていれば authenticated ロールになる。 */
export async function browserClient(login?: { email: string; password: string }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (login) {
    const { error } = await client.auth.signInWithPassword(login);
    if (error) throw new Error(`テストユーザーでログインできません: ${error.message}`);
  }
  return client;
}

export interface TestLineConnectionOptions {
  newReservationEnabled?: boolean;
  cancellationEnabled?: boolean;
  status?: "connected" | "not_connected";
  label?: string;
}

/** テスト用のLINE送信先(スタッフ)を1件作り、idを返す。 */
export async function createTestLineConnection(
  salonId: string,
  options?: TestLineConnectionOptions
): Promise<string> {
  const supabase = adminClient();
  const destinationId = `U_test_${Math.random().toString(36).slice(2, 12)}`;
  const { data, error } = await supabase
    .from("line_connections")
    .insert({
      salon_id: salonId,
      destination_id: destinationId,
      label: options?.label ?? "テストスタッフ",
      status: options?.status ?? "connected",
      new_reservation_enabled: options?.newReservationEnabled ?? true,
      cancellation_enabled: options?.cancellationEnabled ?? true,
      linked_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`line_connections作成に失敗: ${error?.message}`);
  return data.id;
}

export async function setMasterEnabled(salonId: string, masterEnabled: boolean): Promise<void> {
  const supabase = adminClient();
  const { error } = await supabase
    .from("notification_settings")
    .upsert({ salon_id: salonId, master_enabled: masterEnabled }, { onConflict: "salon_id" });
  if (error) throw new Error(`notification_settings作成に失敗: ${error.message}`);
}

export { adminClient as notificationsTestAdminClient };
