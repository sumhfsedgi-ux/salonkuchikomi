import { GOOGLE_SCOPES, hasScopeFor } from "@/lib/google/scopes";
import type { GoogleAuthState } from "@/lib/google/db/accounts";

// 届いた口コミが Google の API を呼ぶための、共通の Google 連携(0021)への入口(計画 第2版 §3-3・§3-B)。
// 口コミ専用の OAuth・トークンの保存は持たない。店舗の口コミの結び付け(salon_google_bindings の feature='gbp')が指す
// Google アカウント(google_accounts)の refresh token から、そのつどアクセストークンを取る。
//
// 失敗の記録の決まり(予約メールの Gmail を巻き込まない):
//   ・口コミの権限が無いと確かめられたとき(トークンの応答の scope に business.manage が無い、または API の 403 の理由が
//     権限不足)だけ、口コミの結び付けに記録する(google_mark_binding_scope(salon, 'gbp'))。
//   ・アカウント全体の認証の失敗(google_record_auth_result)は、口コミの処理からは記録しない。refresh token が無効なら
//     「再連携が必要」と表示するだけにする(アカウント単位の判定・予約通知の停止の記録は、既存の予約通知の定期処理が持つ)。
//   ・原因の分からない失敗では、連携の状態を変えない。

export interface GbpBinding {
  googleAccountId: string;
  googleSub: string;
  email: string | null;
  authState: GoogleAuthState;
  /** 口コミの権限が足りないと記録されている(結び付けの scope_missing_since)。 */
  scopeMissing: boolean;
  /** アカウントの許可済みの scope に business.manage がある。 */
  scopeGranted: boolean;
  selectionState: "selection_pending" | "selected";
  accountBoundAt: string;
}

export type GbpTokenFailure = "invalid_grant" | "scope_missing" | "unavailable";

export class GbpTokenError extends Error {
  constructor(readonly kind: GbpTokenFailure) {
    super(`gbp token: ${kind}`);
    this.name = "GbpTokenError";
  }
}

export interface GbpAccess {
  /** 店舗の口コミの結び付け(無ければ null)。 */
  binding(salonId: string): Promise<GbpBinding | null>;
  /** アクセストークン(架空モードでは架空の口コミの API が読める形)。失敗は GbpTokenError。 */
  accessToken(binding: GbpBinding, options?: { fresh?: boolean }): Promise<string>;
  /** 口コミの権限が足りないと確かめられた(その店舗の口コミの結び付けにだけ記録する)。 */
  markScopeMissing(salonId: string, grantedScopes: string[] | null): Promise<void>;
}

export const GBP_SCOPE = GOOGLE_SCOPES.gbp;

/** 口コミの権限があるか(scope の一覧が分からないときは、あるとは見なさない)。 */
export function grantsGbp(scopes: readonly string[] | null | undefined): boolean {
  return hasScopeFor(scopes ?? null, "gbp");
}
