import { getNotificationsSupabaseAdmin as getServiceRoleClient } from "@/lib/notifications/admin";
import { openSecret, refreshTokenAad, sealSecret, type SealedSecret } from "@/lib/google/tokenBox";

// google_accounts(0021)。Google アカウント単位の認証情報で、店舗には属さない。
// service-role 経由でのみ扱う(ブラウザのロールからは権限を取り消してある)。

export type GoogleAuthState = "active" | "needs_reauth" | "revoking" | "revoked";

export interface GoogleAccount {
  id: string;
  oauthClientId: string;
  googleSub: string;
  email: string | null;
  tokenGeneration: number;
  grantedScopes: string[];
  authState: GoogleAuthState;
  consecutiveAuthFailures: number;
  lastRefreshedAt: string | null;
  sealed: SealedSecret | null;
}

interface Row {
  id: string;
  oauth_client_id: string;
  google_sub: string;
  email: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  key_version: string | null;
  token_generation: number;
  granted_scopes: string[] | null;
  auth_state: string;
  consecutive_auth_failures: number;
  last_refreshed_at: string | null;
}

const COLUMNS =
  "id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, key_version, token_generation, granted_scopes, auth_state, consecutive_auth_failures, last_refreshed_at";

function toAccount(row: Row): GoogleAccount {
  const sealed =
    row.refresh_token_ciphertext && row.refresh_token_iv && row.refresh_token_tag && row.key_version
      ? { ciphertext: row.refresh_token_ciphertext, iv: row.refresh_token_iv, tag: row.refresh_token_tag, keyVersion: row.key_version }
      : null;
  return {
    id: row.id,
    oauthClientId: row.oauth_client_id,
    googleSub: row.google_sub,
    email: row.email,
    tokenGeneration: row.token_generation,
    grantedScopes: row.granted_scopes ?? [],
    authState: row.auth_state as GoogleAuthState,
    consecutiveAuthFailures: row.consecutive_auth_failures,
    lastRefreshedAt: row.last_refreshed_at,
    sealed,
  };
}

export async function findGoogleAccount(clientId: string, googleSub: string): Promise<GoogleAccount | null> {
  const { data, error } = await getServiceRoleClient()
    .from("google_accounts")
    .select(COLUMNS)
    .eq("oauth_client_id", clientId)
    .eq("google_sub", googleSub)
    .maybeSingle();
  if (error) throw new Error("Googleアカウント情報の取得に失敗しました。");
  return data ? toAccount(data as Row) : null;
}

export async function getGoogleAccount(id: string): Promise<GoogleAccount | null> {
  const { data, error } = await getServiceRoleClient().from("google_accounts").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error("Googleアカウント情報の取得に失敗しました。");
  return data ? toAccount(data as Row) : null;
}

export function openRefreshToken(account: GoogleAccount): string {
  if (!account.sealed) throw new Error("このGoogleアカウントには保存済みのトークンがありません。");
  return openSecret(account.sealed, refreshTokenAad(account.id, account.tokenGeneration));
}

export async function createGoogleAccount(params: {
  clientId: string;
  googleSub: string;
  email: string | null;
  refreshToken: string;
  grantedScopes: string[];
}): Promise<GoogleAccount | null> {
  const id = crypto.randomUUID();
  const sealed = sealSecret(params.refreshToken, refreshTokenAad(id, 1));
  const { data, error } = await getServiceRoleClient().rpc("google_create_account", {
    p_id: id,
    p_client_id: params.clientId,
    p_sub: params.googleSub,
    p_email: params.email,
    p_ciphertext: sealed.ciphertext,
    p_iv: sealed.iv,
    p_tag: sealed.tag,
    p_key_version: sealed.keyVersion,
    p_granted_scopes: params.grantedScopes,
  });
  if (error) throw new Error("Googleアカウント情報の保存に失敗しました。");
  const row = (data as Row[] | null)?.[0];
  return row ? toAccount(row) : null; // null: 同時に同じアカウントが作られた(呼び出し側が読み直す)
}

export type ReplaceTokenResult = "replaced" | "generation_mismatch" | "revocation_in_progress" | "not_found";

export async function replaceGoogleAccountToken(params: {
  account: GoogleAccount;
  email: string | null;
  refreshToken: string;
  grantedScopes: string[];
}): Promise<ReplaceTokenResult> {
  const nextGeneration = params.account.tokenGeneration + 1;
  const sealed = sealSecret(params.refreshToken, refreshTokenAad(params.account.id, nextGeneration));
  const { data, error } = await getServiceRoleClient().rpc("google_replace_account_token", {
    p_id: params.account.id,
    p_expected_generation: params.account.tokenGeneration,
    p_email: params.email,
    p_ciphertext: sealed.ciphertext,
    p_iv: sealed.iv,
    p_tag: sealed.tag,
    p_key_version: sealed.keyVersion,
    p_granted_scopes: params.grantedScopes,
  });
  if (error) throw new Error("Googleアカウント情報の更新に失敗しました。");
  return data as ReplaceTokenResult;
}

export async function touchGoogleAccount(params: {
  account: GoogleAccount;
  email: string | null;
  grantedScopes: string[];
}): Promise<"touched" | "not_reusable" | "not_found"> {
  const { data, error } = await getServiceRoleClient().rpc("google_touch_account", {
    p_id: params.account.id,
    p_expected_generation: params.account.tokenGeneration,
    p_email: params.email,
    p_granted_scopes: params.grantedScopes,
  });
  if (error) throw new Error("Googleアカウント情報の更新に失敗しました。");
  return data as "touched" | "not_reusable" | "not_found";
}

export type AuthResult = "ok" | "recovered" | "failure_recorded" | "became_needs_reauth" | "ignored";

export async function recordGoogleAuthResult(accountId: string, ok: boolean): Promise<AuthResult> {
  const { data, error } = await getServiceRoleClient().rpc("google_record_auth_result", { p_id: accountId, p_ok: ok });
  if (error) throw new Error("Google認証の結果の記録に失敗しました。");
  return data as AuthResult;
}
