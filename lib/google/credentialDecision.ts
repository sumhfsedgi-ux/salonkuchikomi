// Google の認可が戻ってきたとき、保存済みの認証情報をどう扱うかの判断(DBに触れない純粋な関数)。
//
//   create         このアカウント(同じクライアント・同じ sub)が未保存で、新しい refresh token がある
//   replace        保存済みで、新しい refresh token があり、新しい許可が既存の結び付けに必要な権限を全部含む
//   reuse          新しい refresh token が無い。保存済み(同じクライアント・同じ sub・有効)なので、
//                  それで更新できること・権限を確かめてから使い続ける
//   force_consent  refresh token が必要なのに得られない。1回だけ prompt=consent で取り直す
//   reject         取り直しても得られない、または新しい許可が既存の権限より狭い(既存を壊さない)
//
// 置き換え前のトークンは revoke しない(Google の revoke はそのプロジェクトへの許可を全部取り消すため)。

export type CredentialDecision =
  | { kind: "create" }
  | { kind: "replace" }
  | { kind: "reuse" }
  | { kind: "force_consent" }
  | { kind: "reject"; reason: "no_refresh_token" | "scope_regression" };

export interface CredentialDecisionInput {
  hasNewRefreshToken: boolean;
  existing: { authState: "active" | "needs_reauth" | "revoking" | "revoked"; hasToken: boolean } | null;
  /** 今回の認可で実際に許可された scope(応答で確認できたもの)。 */
  newGrantedScopes: readonly string[];
  /** このアカウントの既存の結び付け(全店舗・全機能)が必要とする scope。 */
  scopesNeededByExistingBindings: readonly string[];
  forcedConsentAlready: boolean;
}

export function decideCredentialAction(input: CredentialDecisionInput): CredentialDecision {
  if (input.hasNewRefreshToken) {
    if (!input.existing || !input.existing.hasToken || input.existing.authState === "revoked" || input.existing.authState === "revoking") {
      return input.existing ? { kind: "replace" } : { kind: "create" };
    }
    const granted = new Set(input.newGrantedScopes);
    const coversExisting = input.scopesNeededByExistingBindings.every((s) => granted.has(s));
    return coversExisting ? { kind: "replace" } : { kind: "reject", reason: "scope_regression" };
  }
  if (input.existing && input.existing.authState === "active" && input.existing.hasToken) {
    return { kind: "reuse" };
  }
  return input.forcedConsentAlready ? { kind: "reject", reason: "no_refresh_token" } : { kind: "force_consent" };
}
