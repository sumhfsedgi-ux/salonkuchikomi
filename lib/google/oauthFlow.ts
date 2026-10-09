import { buildGoogleAuthorizationUrl } from "@/lib/google/authUrl";
import type { GoogleOAuthConfig } from "@/lib/google/config";
import { decideCredentialAction } from "@/lib/google/credentialDecision";
import {
  createGoogleAccount,
  findGoogleAccount,
  openRefreshToken,
  replaceGoogleAccountToken,
  touchGoogleAccount,
  type GoogleAccount,
} from "@/lib/google/db/accounts";
import {
  bindGoogleFeatures,
  GmailAccountInUseError,
  listSalonsBoundToAccount,
  recordConnectionEvent,
} from "@/lib/google/db/bindings";
import {
  consumeOAuthState,
  insertOAuthState,
  type OAuthPurpose,
  type OAuthReturnTo,
  type StoredOAuthState,
} from "@/lib/google/db/oauthStates";
import { IdTokenError, verifyGoogleIdToken, type VerifiedGoogleIdentity } from "@/lib/google/idToken";
import { isWellFormedToken, pkceChallenge, randomToken, sha256Hex } from "@/lib/google/randomness";
import { logSafeError } from "@/lib/google/safeError";
import { GOOGLE_SCOPES, grantedFeatures, parseGrantedScopes, scopesForFeatures, type GoogleFeature } from "@/lib/google/scopes";
import { openSecret, pkceVerifierAad, sealSecret } from "@/lib/google/tokenBox";
import { GoogleOAuthError, type GoogleOAuthTransport } from "@/lib/google/transport";

// SalonPack 共通の Google 連携(開始とコールバック)。
// 運用状態(予約通知の切り替え待ち・稼働中・停止中)には一切触れない
// -- Google に接続・再接続・再認証・権限追加をしても、予約通知は始まらない。

export interface GoogleFlowDeps {
  transport: GoogleOAuthTransport;
  config: GoogleOAuthConfig;
  /** 届いた口コミ(business.manage)を要求してよいか。 */
  reviewsEnabled: boolean;
  authorizationEndpoint?: string;
  now?: () => Date;
}

export class GoogleConnectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleConnectInputError";
  }
}

export interface StartGoogleConnectParams {
  salonId: string;
  userId: string;
  features: GoogleFeature[];
  purpose: OAuthPurpose;
  /** 再認証・権限追加のとき、開始時に期待しているアカウント(sub)。 */
  expectedGoogleSub?: string | null;
  loginHint?: string | null;
  forceConsent?: boolean;
  returnTo?: OAuthReturnTo;
}

export async function startGoogleConnect(params: StartGoogleConnectParams, deps: GoogleFlowDeps): Promise<string> {
  const features = Array.from(new Set(params.features));
  if (features.length === 0) throw new GoogleConnectInputError("連携する機能を選んでください。");
  if (features.includes("gbp") && !deps.reviewsEnabled) {
    throw new GoogleConnectInputError("届いた口コミのGoogle連携は準備中です。");
  }
  const needsExpected = params.purpose === "reauth" || params.purpose === "add_scope";
  if (needsExpected !== Boolean(params.expectedGoogleSub)) {
    throw new GoogleConnectInputError("再認証・権限追加では、接続中のアカウントを指定する必要があります。");
  }

  const state = randomToken(32);
  const nonce = randomToken(32);
  const verifier = randomToken(48);
  const stateHash = sha256Hex(state);
  await insertOAuthState(
    {
      stateHash,
      userId: params.userId,
      salonId: params.salonId,
      features,
      purpose: params.purpose,
      expectedGoogleSub: needsExpected ? params.expectedGoogleSub! : null,
      forcedConsent: Boolean(params.forceConsent),
      codeVerifier: sealSecret(verifier, pkceVerifierAad(stateHash, params.userId, params.salonId)),
      nonceHash: sha256Hex(nonce),
      returnTo: params.returnTo ?? "settings_google",
    },
    deps.now?.()
  );

  return buildGoogleAuthorizationUrl({
    clientId: deps.config.clientId,
    redirectUri: deps.config.redirectUri,
    scopes: scopesForFeatures(features),
    state,
    codeChallenge: pkceChallenge(verifier),
    nonce,
    loginHint: params.loginHint ?? undefined,
    forceConsent: params.forceConsent,
    endpoint: deps.authorizationEndpoint,
  });
}

export type CompleteFailure =
  | "state_invalid"
  | "denied"
  | "exchange_failed"
  | "id_token_invalid"
  | "account_mismatch"
  | "no_scope_granted"
  | "no_refresh_token"
  | "scope_regression"
  | "revocation_in_progress"
  | "gmail_account_in_use"
  | "config";

export type CompleteResult =
  | {
      status: "connected";
      returnTo: OAuthReturnTo;
      bound: Array<{ feature: GoogleFeature; event: string }>;
      missing: GoogleFeature[];
      accountEmail: string | null;
    }
  | { status: "retry"; url: string }
  | { status: "failed"; reason: CompleteFailure; returnTo: OAuthReturnTo };

export interface CompleteGoogleConnectParams {
  /** セッションから解決した、今ログインしているユーザーと店舗(クエリやフォームから受け取らない)。 */
  salonId: string;
  userId: string;
  stateParam: string | null;
  code: string | null;
  oauthError: string | null;
}

async function scopesNeededByBindings(account: GoogleAccount): Promise<string[]> {
  const bindings = await listSalonsBoundToAccount(account.id);
  return Array.from(new Set(bindings.map((b) => GOOGLE_SCOPES[b.feature])));
}

export async function completeGoogleConnect(
  params: CompleteGoogleConnectParams,
  deps: GoogleFlowDeps
): Promise<CompleteResult> {
  if (!isWellFormedToken(params.stateParam)) {
    return { status: "failed", reason: "state_invalid", returnTo: "settings_google" };
  }
  // ユーザー・店舗が開始時と違う(途中でログアウト・別ユーザー・別店舗に切り替わった)、
  // 期限切れ、使用済みの state はここで拒否される。
  const consumed = await consumeOAuthState(sha256Hex(params.stateParam), params.salonId, params.userId);
  if (!consumed) return { status: "failed", reason: "state_invalid", returnTo: "settings_google" };
  const state: StoredOAuthState = consumed;
  const fail = (reason: CompleteFailure): CompleteResult => ({ status: "failed", reason, returnTo: state.returnTo });

  if (params.oauthError || !params.code) return fail("denied");

  let verifier: string;
  try {
    verifier = openSecret(state.codeVerifier, pkceVerifierAad(state.stateHash, state.userId, state.salonId));
  } catch (error) {
    logSafeError("google/callback verifier", error);
    return fail("state_invalid");
  }

  let tokens;
  try {
    tokens = await deps.transport.exchangeCode({
      code: params.code,
      codeVerifier: verifier,
      redirectUri: deps.config.redirectUri,
      clientId: deps.config.clientId,
      clientSecret: deps.config.clientSecret,
    });
  } catch (error) {
    logSafeError("google/callback exchange", error);
    return fail(error instanceof GoogleOAuthError && error.kind === "invalid_client" ? "config" : "exchange_failed");
  }

  let identity: VerifiedGoogleIdentity;
  try {
    const certs = await deps.transport.fetchSigningCerts();
    identity = await verifyGoogleIdToken(tokens.idToken, {
      clientId: deps.config.clientId,
      expectedNonceHash: state.nonceHash,
      certs,
    });
  } catch (error) {
    logSafeError("google/callback id_token", error instanceof IdTokenError ? { name: "IdTokenError", kind: error.reason } : error);
    return fail("id_token_invalid");
  }

  // 再認証・権限追加: 開始時に期待していたアカウントと違えば、何も保存せずに拒否する。
  if (state.expectedGoogleSub && state.expectedGoogleSub !== identity.sub) return fail("account_mismatch");

  const exchangeScopes = parseGrantedScopes(tokens.scope) ?? [];
  const existing = await findGoogleAccount(deps.config.clientId, identity.sub);
  const decision = decideCredentialAction({
    hasNewRefreshToken: Boolean(tokens.refreshToken),
    existing: existing ? { authState: existing.authState, hasToken: Boolean(existing.sealed) } : null,
    newGrantedScopes: exchangeScopes,
    scopesNeededByExistingBindings: existing ? await scopesNeededByBindings(existing) : [],
    forcedConsentAlready: state.forcedConsent,
  });

  // 実際に使える認証情報と、その認証情報で確認できた権限。
  let account: GoogleAccount | null = existing;
  let credentialScopes: string[] = exchangeScopes;

  async function forceConsentOnce(): Promise<CompleteResult> {
    if (state.forcedConsent) return fail("no_refresh_token");
    const url = await startGoogleConnect(
      {
        salonId: state.salonId,
        userId: state.userId,
        features: state.features,
        purpose: state.purpose,
        expectedGoogleSub: state.expectedGoogleSub,
        loginHint: identity.email,
        forceConsent: true,
        returnTo: state.returnTo,
      },
      deps
    );
    return { status: "retry", url };
  }

  const requestedGranted = grantedFeatures(exchangeScopes, state.features);
  if (requestedGranted.length === 0) {
    for (const feature of state.features) {
      await recordConnectionEvent({
        salonId: state.salonId,
        feature,
        googleAccountId: existing?.id ?? null,
        accountEmail: identity.email,
        event: "scope_missing",
        grantedScopes: exchangeScopes,
        userId: state.userId,
      });
    }
    return fail("no_scope_granted");
  }

  switch (decision.kind) {
    case "reject":
      return fail(decision.reason);
    case "force_consent":
      return forceConsentOnce();
    case "create": {
      account = await createGoogleAccount({
        clientId: deps.config.clientId,
        googleSub: identity.sub,
        email: identity.email,
        refreshToken: tokens.refreshToken!,
        grantedScopes: exchangeScopes,
      });
      if (!account) {
        // 同時に同じアカウントが保存された。読み直して置き換える。
        const reloaded = await findGoogleAccount(deps.config.clientId, identity.sub);
        if (!reloaded) return fail("exchange_failed");
        const result = await replaceGoogleAccountToken({
          account: reloaded,
          email: identity.email,
          refreshToken: tokens.refreshToken!,
          grantedScopes: exchangeScopes,
        });
        if (result === "revocation_in_progress") return fail("revocation_in_progress");
        if (result !== "replaced") return fail("exchange_failed");
        account = await findGoogleAccount(deps.config.clientId, identity.sub);
      }
      break;
    }
    case "replace": {
      let current = existing!;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await replaceGoogleAccountToken({
          account: current,
          email: identity.email,
          refreshToken: tokens.refreshToken!,
          grantedScopes: exchangeScopes,
        });
        if (result === "replaced") break;
        if (result === "revocation_in_progress") return fail("revocation_in_progress");
        const reloaded = await findGoogleAccount(deps.config.clientId, identity.sub);
        if (!reloaded || attempt === 1) return fail("exchange_failed");
        current = reloaded;
      }
      account = await findGoogleAccount(deps.config.clientId, identity.sub);
      break;
    }
    case "reuse": {
      // 新しい refresh token が無い: 保存済みのトークンで実際に更新でき、要求した権限が
      // 含まれることを確かめてから使い続ける。確かめられなければ1回だけ同意を取り直す。
      let refreshedScopes: string[] | null = null;
      try {
        const refreshed = await deps.transport.refreshAccessToken({
          refreshToken: openRefreshToken(existing!),
          clientId: deps.config.clientId,
          clientSecret: deps.config.clientSecret,
        });
        refreshedScopes = parseGrantedScopes(refreshed.scope);
      } catch (error) {
        logSafeError("google/callback reuse-refresh", error);
        if (error instanceof GoogleOAuthError && error.kind === "network") return fail("exchange_failed");
        return forceConsentOnce();
      }
      if (!refreshedScopes || grantedFeatures(refreshedScopes, requestedGranted).length !== requestedGranted.length) {
        return forceConsentOnce();
      }
      const touched = await touchGoogleAccount({ account: existing!, email: identity.email, grantedScopes: refreshedScopes });
      if (touched !== "touched") return forceConsentOnce();
      credentialScopes = refreshedScopes;
      account = await findGoogleAccount(deps.config.clientId, identity.sub);
      break;
    }
  }
  if (!account) return fail("exchange_failed");

  // 要求した機能のうち、実際に使える認証情報で許可が確認できたものだけを結び付ける。
  const bindable = grantedFeatures(credentialScopes, state.features);
  const missing = state.features.filter((f) => !bindable.includes(f));
  let bound: Array<{ feature: GoogleFeature; event: string }>;
  try {
    bound = await bindGoogleFeatures({
      salonId: state.salonId,
      accountId: account.id,
      features: bindable,
      accountEmail: identity.email,
      userId: state.userId,
      grantedScopes: credentialScopes,
    });
  } catch (error) {
    if (error instanceof GmailAccountInUseError) return fail("gmail_account_in_use");
    throw error;
  }
  for (const feature of missing) {
    await recordConnectionEvent({
      salonId: state.salonId,
      feature,
      googleAccountId: account.id,
      accountEmail: identity.email,
      event: "scope_missing",
      grantedScopes: credentialScopes,
      userId: state.userId,
    });
  }
  return { status: "connected", returnTo: state.returnTo, bound, missing, accountEmail: identity.email };
}

export type { StoredOAuthState };
