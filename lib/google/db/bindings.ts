import { getNotificationsSupabaseAdmin as getServiceRoleClient } from "@/lib/notifications/admin";
import type { GoogleFeature } from "@/lib/google/scopes";
import type { GoogleAuthState } from "@/lib/google/db/accounts";

// salon_google_bindings(0021): この店舗の予約メール(gmail)・届いた口コミ(gbp)が、
// どの Google アカウントの認証情報を使うか。結び付けは、その店舗のユーザーがその店舗の
// ために Google の認可を完了したときにだけ作る(OAuth のコールバックから)。

export interface SalonGoogleBinding {
  salonId: string;
  feature: GoogleFeature;
  googleAccountId: string;
  accountEmail: string | null;
  gbpSelectionState: "selection_pending" | "selected" | null;
  firstConnectedAt: string;
  lastReconnectedAt: string | null;
  accountBoundAt: string;
  /** この機能だけの権限不足を記録した日時(アカウント全体の認証状態とは別)。 */
  scopeMissingSince: string | null;
  account: {
    authState: GoogleAuthState;
    grantedScopes: string[];
    email: string | null;
    googleSub: string;
  };
}

interface Row {
  salon_id: string;
  feature: string;
  google_account_id: string;
  account_email: string | null;
  gbp_selection_state: string | null;
  first_connected_at: string;
  last_reconnected_at: string | null;
  account_bound_at: string;
  scope_missing_since: string | null;
  google_accounts:
    | { auth_state: string; granted_scopes: string[] | null; email: string | null; google_sub: string }
    | Array<{ auth_state: string; granted_scopes: string[] | null; email: string | null; google_sub: string }>
    | null;
}

export async function listSalonGoogleBindings(salonId: string): Promise<SalonGoogleBinding[]> {
  const { data, error } = await getServiceRoleClient()
    .from("salon_google_bindings")
    .select(
      "salon_id, feature, google_account_id, account_email, gbp_selection_state, first_connected_at, last_reconnected_at, account_bound_at, scope_missing_since, google_accounts(auth_state, granted_scopes, email, google_sub)"
    )
    .eq("salon_id", salonId);
  if (error) throw new Error("Google連携の状態の取得に失敗しました。");
  return ((data ?? []) as Row[]).map((row) => {
    const account = Array.isArray(row.google_accounts) ? row.google_accounts[0] : row.google_accounts;
    return {
      salonId: row.salon_id,
      feature: row.feature as GoogleFeature,
      googleAccountId: row.google_account_id,
      accountEmail: row.account_email,
      gbpSelectionState: row.gbp_selection_state as SalonGoogleBinding["gbpSelectionState"],
      firstConnectedAt: row.first_connected_at,
      lastReconnectedAt: row.last_reconnected_at,
      accountBoundAt: row.account_bound_at,
      scopeMissingSince: row.scope_missing_since,
      account: {
        authState: (account?.auth_state ?? "revoked") as GoogleAuthState,
        grantedScopes: account?.granted_scopes ?? [],
        email: account?.email ?? null,
        googleSub: account?.google_sub ?? "",
      },
    };
  });
}

export class GmailAccountInUseError extends Error {
  constructor() {
    super("この Gmail は別の店舗の予約通知で使われています。");
    this.name = "GmailAccountInUseError";
  }
}

export async function bindGoogleFeatures(params: {
  salonId: string;
  accountId: string;
  features: GoogleFeature[];
  accountEmail: string | null;
  userId: string;
  grantedScopes: string[];
}): Promise<Array<{ feature: GoogleFeature; event: string }>> {
  if (params.features.length === 0) return [];
  const { data, error } = await getServiceRoleClient().rpc("google_bind_features", {
    p_salon_id: params.salonId,
    p_account_id: params.accountId,
    p_features: params.features,
    p_account_email: params.accountEmail,
    p_user_id: params.userId,
    p_granted_scopes: params.grantedScopes,
  });
  if (error) {
    if (error.message?.includes("google:gmail_account_in_use")) throw new GmailAccountInUseError();
    throw new Error("Google連携の保存に失敗しました。");
  }
  return (data as Array<{ feature: GoogleFeature; event: string }>) ?? [];
}

export async function unbindGoogleFeatures(params: {
  salonId: string;
  features: GoogleFeature[];
  userId: string;
  revokeIfUnreferenced: boolean;
}): Promise<Array<{ googleAccountId: string; remainingReferences: number; revocationEnqueued: boolean }>> {
  const { data, error } = await getServiceRoleClient().rpc("google_unbind_features", {
    p_salon_id: params.salonId,
    p_features: params.features,
    p_user_id: params.userId,
    p_revoke_if_unreferenced: params.revokeIfUnreferenced,
  });
  if (error) throw new Error("Google連携の解除に失敗しました。");
  return ((data ?? []) as Array<{ google_account_id: string; remaining_references: number; revocation_enqueued: boolean }>).map((r) => ({
    googleAccountId: r.google_account_id,
    remainingReferences: r.remaining_references,
    revocationEnqueued: r.revocation_enqueued,
  }));
}

export type BindingScopeResult = "became_missing" | "already_missing" | "restored" | "ok" | "not_bound";

/**
 * その機能だけの権限不足を、店舗×機能の結び付けに記録する・消す(状態が変わったときだけ履歴を残す)。
 * Google アカウント全体の認証状態・失敗回数(google_record_auth_result)には触れない。
 */
export async function markBindingScope(params: {
  salonId: string;
  feature: GoogleFeature;
  missing: boolean;
  grantedScopes: string[] | null;
}): Promise<BindingScopeResult> {
  const { data, error } = await getServiceRoleClient().rpc("google_mark_binding_scope", {
    p_salon_id: params.salonId,
    p_feature: params.feature,
    p_missing: params.missing,
    p_granted_scopes: params.grantedScopes,
  });
  if (error) throw new Error("Google連携の権限の状態の記録に失敗しました。");
  return data as BindingScopeResult;
}

export type ConnectionEvent =
  | "connected"
  | "reconnected"
  | "account_switched"
  | "scope_added"
  | "scope_missing"
  | "scope_restored"
  | "needs_reauth"
  | "reauthed"
  | "unbound"
  | "revocation_enqueued"
  | "revocation_cancelled"
  | "revoked";

export async function recordConnectionEvent(params: {
  salonId: string;
  feature: GoogleFeature | null;
  googleAccountId: string | null;
  accountEmail: string | null;
  event: ConnectionEvent;
  grantedScopes?: string[] | null;
  userId?: string | null;
}): Promise<void> {
  const { error } = await getServiceRoleClient().from("salon_google_connection_events").insert({
    salon_id: params.salonId,
    feature: params.feature,
    google_account_id: params.googleAccountId,
    account_email: params.accountEmail,
    event: params.event,
    granted_scopes: params.grantedScopes ?? null,
    by_user_id: params.userId ?? null,
  });
  if (error) console.error("[google] recordConnectionEvent failed", { code: error.code });
}

/** あるアカウントを予約メールに使っている店舗(1件以下。予約メールは1アカウント=1店舗)。 */
export async function listSalonsBoundToAccount(accountId: string): Promise<Array<{ salonId: string; feature: GoogleFeature }>> {
  const { data, error } = await getServiceRoleClient()
    .from("salon_google_bindings")
    .select("salon_id, feature")
    .eq("google_account_id", accountId);
  if (error) throw new Error("Google連携の状態の取得に失敗しました。");
  return ((data ?? []) as Array<{ salon_id: string; feature: string }>).map((r) => ({
    salonId: r.salon_id,
    feature: r.feature as GoogleFeature,
  }));
}
