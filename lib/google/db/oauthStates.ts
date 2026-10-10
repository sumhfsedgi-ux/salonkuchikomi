import { getNotificationsSupabaseAdmin as getServiceRoleClient } from "@/lib/notifications/admin";
import type { GoogleFeature } from "@/lib/google/scopes";
import type { SealedSecret } from "@/lib/google/tokenBox";

// google_oauth_states(0021)。state そのものは保存せず、SHA-256 のハッシュだけを保存する。
// 開始したユーザー・店舗・用途に結び付け、10分の期限付きで、1回だけ消費できる。

export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export type OAuthPurpose = "connect" | "add_scope" | "reauth" | "switch_account";
export type OAuthReturnTo = "settings_google" | "dashboard" | "notifications";

export interface StoredOAuthState {
  stateHash: string;
  userId: string;
  salonId: string;
  features: GoogleFeature[];
  purpose: OAuthPurpose;
  expectedGoogleSub: string | null;
  forcedConsent: boolean;
  codeVerifier: SealedSecret;
  nonceHash: string;
  returnTo: OAuthReturnTo;
}

interface Row {
  state_hash: string;
  user_id: string;
  salon_id: string;
  features: string[];
  purpose: string;
  expected_google_sub: string | null;
  forced_consent: boolean;
  code_verifier_ciphertext: string;
  code_verifier_iv: string;
  code_verifier_tag: string;
  key_version: string;
  nonce_hash: string;
  return_to: string;
}

export async function insertOAuthState(state: StoredOAuthState, now: Date = new Date()): Promise<void> {
  const { error } = await getServiceRoleClient().from("google_oauth_states").insert({
    state_hash: state.stateHash,
    user_id: state.userId,
    salon_id: state.salonId,
    features: state.features,
    purpose: state.purpose,
    expected_google_sub: state.expectedGoogleSub,
    forced_consent: state.forcedConsent,
    code_verifier_ciphertext: state.codeVerifier.ciphertext,
    code_verifier_iv: state.codeVerifier.iv,
    code_verifier_tag: state.codeVerifier.tag,
    key_version: state.codeVerifier.keyVersion,
    nonce_hash: state.nonceHash,
    return_to: state.returnTo,
    expires_at: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) throw new Error("Google連携の開始に失敗しました。");
}

/** 原子的に1回だけ消費する。ユーザー・店舗が開始時と違う・期限切れ・使用済みなら null。 */
export async function consumeOAuthState(stateHash: string, salonId: string, userId: string): Promise<StoredOAuthState | null> {
  const { data, error } = await getServiceRoleClient().rpc("google_consume_oauth_state", {
    p_state_hash: stateHash,
    p_salon_id: salonId,
    p_user_id: userId,
  });
  if (error) throw new Error("Google連携の確認に失敗しました。");
  const row = (data as Row[] | null)?.[0];
  if (!row) return null;
  return {
    stateHash: row.state_hash,
    userId: row.user_id,
    salonId: row.salon_id,
    features: row.features as GoogleFeature[],
    purpose: row.purpose as OAuthPurpose,
    expectedGoogleSub: row.expected_google_sub,
    forcedConsent: row.forced_consent,
    codeVerifier: {
      ciphertext: row.code_verifier_ciphertext,
      iv: row.code_verifier_iv,
      tag: row.code_verifier_tag,
      keyVersion: row.key_version,
    },
    nonceHash: row.nonce_hash,
    returnTo: row.return_to as OAuthReturnTo,
  };
}
