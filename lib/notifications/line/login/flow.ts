import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import { isWellFormedToken, pkceChallenge, randomToken, safeEqualHex, sha256Hex } from "@/lib/google/randomness";
import { logSafeError } from "@/lib/google/safeError";
import { openSecret, sealSecret } from "@/lib/google/tokenBox";
import { hashInviteToken, isWellFormedInviteToken } from "@/lib/notifications/recipients/invites";
import { LINE_ID_TOKEN_ISSUER, type LineLoginConfig } from "@/lib/notifications/line/login/config";
import type { LineLoginTransport } from "@/lib/notifications/line/login/transport";

// スタッフ本人の LINE 連携(招待 → LINE ログイン → 通知先の登録)の流れ。
//   - ブラウザとの結び付け: httpOnly の cookie に乱数を置き、DB には sha256 だけを保存する(line_invite_flows)。
//   - どの招待か: 招待を開いたときの「進行」(招待1件 × ブラウザ1つ)の id で、表示・開始・state・コールバック・
//     結果の表示・再試行を一貫して同じ招待に結び付ける。ブラウザ全体の「最新の招待」では選ばない
//     (別のタブで別の店舗の招待を開いても、取り違えない)。画面から送られる id は、DB で cookie との対応・期限・
//     招待の状態を確かめてから使う(別のブラウザ・改ざんした id は使えない)。招待の生の値は不要。任意の戻り先は受け付けない。
//   - state・nonce は乱数。DB には sha256 だけを保存する。nonce は ID トークンの検証の結果の値をハッシュにして、
//     保存したハッシュと定数時間で比べる。PKCE の verifier は暗号化して保存する。
//   - LINE のユーザー ID は、サーバーで検証した ID トークンの sub だけを使う(ブラウザから送られた値は使わない)。
//   - 友だちになっていない・キャンセル・途中の通信の失敗では、招待を使用済みにしない(再試行できる)。

export const BINDING_COOKIE = "sp_line_invite";
export const BINDING_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

export type FlowOutcome =
  | "registered"
  | "already_registered"
  | "cancelled"
  | "not_friend"
  | "temporary_failure"
  | "invite_invalid";

export type InviteStatus = "valid" | "expired" | "used" | "revoked" | "not_found";

export function newBindingValue(): string {
  return randomToken(32);
}

export function bindingHashOf(value: string | undefined | null): string | null {
  return value && isWellFormedToken(value) ? sha256Hex(value) : null;
}

function db() {
  return getNotificationsSupabaseAdmin();
}

const FLOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 画面・URL から受け取った進行の id の形を確かめる(中身の確認は DB で cookie と照合して行う)。 */
export function parseFlowId(value: unknown): string | null {
  return typeof value === "string" && FLOW_ID_PATTERN.test(value) ? value : null;
}

export type OpenInviteResult =
  | { status: "valid"; flowId: string; salonName: string; displayName: string }
  | { status: Exclude<InviteStatus, "valid"> };

/** 招待を開く: 有効なら、このブラウザの進行を作り(同じ招待なら使い直す)、その id と店舗名・表示名を返す。 */
export async function openInvite(token: unknown, bindingHash: string): Promise<OpenInviteResult> {
  if (!isWellFormedInviteToken(token)) return { status: "not_found" };
  const tokenHash = hashInviteToken(token);
  const { data, error } = await db().rpc("line_flow_start", { p_token_hash: tokenHash, p_binding_hash: bindingHash });
  if (error) throw new Error("招待の確認に失敗しました。");
  const started = (data as Array<{ status: InviteStatus; flow_id: string | null }>)[0];
  if (started.status !== "valid" || !started.flow_id) return { status: started.status === "valid" ? "not_found" : started.status };
  const view = await flowView(started.flow_id, bindingHash);
  if (!view) return { status: "not_found" };
  if (view.inviteStatus !== "valid") return { status: view.inviteStatus };
  return { status: "valid", flowId: view.flowId, salonName: view.salonName, displayName: view.displayName };
}

export interface FlowView {
  flowId: string;
  inviteStatus: InviteStatus;
  lastOutcome: FlowOutcome | null;
  salonName: string;
  displayName: string;
  registeredLabel: string | null;
  registeredSalonName: string | null;
}

/**
 * 指定した進行(サーバーで確かめた結果)。このブラウザ(cookie)の進行でなければ null
 * (別のブラウザ・改ざんした id・形の違う値・24時間より前の進行)。
 */
export async function flowView(flowId: unknown, bindingHash: string | null): Promise<FlowView | null> {
  const id = parseFlowId(flowId);
  if (!id || !bindingHash) return null;
  const { data, error } = await db().rpc("line_flow_get", { p_flow_id: id, p_binding_hash: bindingHash });
  if (error) throw new Error("連携の状況の取得に失敗しました。");
  const row = (data as Array<Record<string, unknown>> | null)?.[0];
  if (!row) return null;
  return {
    flowId: row.flow_id as string,
    inviteStatus: row.invite_status as InviteStatus,
    lastOutcome: (row.last_outcome as FlowOutcome | null) ?? null,
    salonName: row.salon_name as string,
    displayName: row.display_name as string,
    registeredLabel: (row.registered_label as string | null) ?? null,
    registeredSalonName: (row.registered_salon_name as string | null) ?? null,
  };
}

export async function recordFlowOutcome(flowId: string, outcome: FlowOutcome): Promise<void> {
  const { error } = await db().rpc("line_flow_record_outcome", { p_flow_id: flowId, p_outcome: outcome });
  if (error) throw new Error("連携の状況の記録に失敗しました。");
}

function pkceAad(stateHash: string, flowId: string): string {
  return `line_pkce:v1:${stateHash}:${flowId}`;
}

/**
 * 指定した進行の LINE ログインを始める: 認可画面の URL を作り、state を保存する(10分・1回限り)。
 * 進行がこのブラウザのものでない・期限切れ・招待が無効・登録済みなら、state を作らず null
 * (DB の line_login_create_state が、確認と作成を同じ関数で行う)。
 */
export async function startLineLogin(flowId: unknown, bindingHash: string | null, config: LineLoginConfig): Promise<string | null> {
  const id = parseFlowId(flowId);
  if (!id || !bindingHash) return null;
  const state = randomToken(32);
  const nonce = randomToken(32);
  const verifier = randomToken(48);
  const stateHash = sha256Hex(state);
  const sealed = sealSecret(verifier, pkceAad(stateHash, id));
  const { data, error } = await db().rpc("line_login_create_state", {
    p_state_hash: stateHash,
    p_flow_id: id,
    p_binding_hash: bindingHash,
    p_nonce_hash: sha256Hex(nonce),
    p_ciphertext: sealed.ciphertext,
    p_iv: sealed.iv,
    p_tag: sealed.tag,
    p_key_version: sealed.keyVersion,
  });
  if (error) throw new Error("LINE連携の開始に失敗しました。");
  if (data !== true) return null;
  return buildAuthorizeUrl(config, { state, nonce, codeChallenge: pkceChallenge(verifier) });
}

export function buildAuthorizeUrl(config: LineLoginConfig, params: { state: string; nonce: string; codeChallenge: string }): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.channelId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("nonce", params.nonce);
  // 公式アカウントを友だち追加する画面を出す(友だちでないと予約通知のプッシュが届かない)。
  url.searchParams.set("bot_prompt", "aggressive");
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * コールバックの結果。flowId は、結果ページで表示する進行(state に結び付いた進行。このブラウザのものだけ)。
 *   - state_invalid: state が使えない(期限切れ・使用済み・別のブラウザ)。このブラウザの state なら flowId を返す。
 *   - error: 結果の記録などに失敗した(LINE の値はログに出さない)。
 */
export type CallbackResult =
  | { kind: "outcome"; outcome: FlowOutcome; flowId: string }
  | { kind: "state_invalid"; flowId: string | null }
  | { kind: "error"; flowId: string };

/** ID トークンの検証の結果を確かめる(発行者・チャネル・期限・ユーザー ID の形・nonce のハッシュ)。 */
export function checkIdTokenPayload(
  payload: { iss: string; sub: string; aud: string; exp: number; nonce?: string },
  expected: { channelId: string; nonceHash: string; nowSeconds: number }
): string | null {
  if (payload.iss !== LINE_ID_TOKEN_ISSUER) return null;
  if (payload.aud !== expected.channelId) return null;
  if (!(payload.exp > expected.nowSeconds)) return null;
  if (!/^U[0-9a-f]{32}$/.test(payload.sub)) return null;
  if (!payload.nonce || !safeEqualHex(sha256Hex(payload.nonce), expected.nonceHash)) return null;
  return payload.sub;
}

/**
 * LINE からのコールバック。どの結果でも、呼び出し側は固定の結果ページ(/line/invite/continue)へ移る。
 * 招待を使用済みにするのは、DB の line_invite_redeem が登録と同じトランザクションで行う場合だけ。
 */
export async function completeLineLogin(
  params: { state: unknown; code: unknown; error: unknown; bindingHash: string | null },
  deps: { transport: LineLoginTransport; config: LineLoginConfig; now?: () => Date }
): Promise<CallbackResult> {
  if (!params.bindingHash || !isWellFormedToken(params.state)) return { kind: "state_invalid", flowId: null };
  const stateHash = sha256Hex(params.state);
  const { data, error } = await db().rpc("line_login_consume_state", { p_state_hash: stateHash, p_binding_hash: params.bindingHash });
  if (error) throw new Error("LINE連携の確認に失敗しました。");
  const consumed = (data as Array<Record<string, string>> | null)?.[0];
  if (!consumed) {
    const { data: owner, error: ownerError } = await db().rpc("line_login_state_flow", {
      p_state_hash: stateHash,
      p_binding_hash: params.bindingHash,
    });
    return { kind: "state_invalid", flowId: ownerError ? null : parseFlowId(owner) };
  }
  const flowId = consumed.flow_id;
  try {
    return await completeConsumedState(flowId, stateHash, consumed, params, deps);
  } catch (err) {
    logSafeError("line/login callback", err);
    return { kind: "error", flowId };
  }
}

async function completeConsumedState(
  flowId: string,
  stateHash: string,
  consumed: Record<string, string>,
  params: { code: unknown; error: unknown },
  deps: { transport: LineLoginTransport; config: LineLoginConfig; now?: () => Date }
): Promise<CallbackResult> {
  const finish = async (outcome: FlowOutcome): Promise<CallbackResult> => {
    await recordFlowOutcome(flowId, outcome);
    return { kind: "outcome", outcome, flowId };
  };

  if (params.error) return finish("cancelled");
  if (typeof params.code !== "string" || params.code.length === 0 || params.code.length > 512) return finish("temporary_failure");

  let sub: string | null;
  let accessToken: string;
  try {
    const verifier = openSecret(
      { ciphertext: consumed.code_verifier_ciphertext, iv: consumed.code_verifier_iv, tag: consumed.code_verifier_tag, keyVersion: consumed.key_version },
      pkceAad(stateHash, flowId)
    );
    const tokens = await deps.transport.exchangeCode({
      code: params.code,
      redirectUri: deps.config.redirectUri,
      channelId: deps.config.channelId,
      channelSecret: deps.config.channelSecret,
      codeVerifier: verifier,
    });
    accessToken = tokens.accessToken;
    const payload = await deps.transport.verifyIdToken({ idToken: tokens.idToken, channelId: deps.config.channelId });
    sub = checkIdTokenPayload(payload, {
      channelId: deps.config.channelId,
      nonceHash: consumed.nonce_hash,
      nowSeconds: Math.floor((deps.now?.() ?? new Date()).getTime() / 1000),
    });
  } catch (err) {
    logSafeError("line/login exchange", err);
    return finish("temporary_failure");
  }
  if (!sub) {
    logSafeError("line/login id_token", new Error("id_token_rejected"));
    return finish("temporary_failure");
  }

  let friend: boolean;
  try {
    friend = (await deps.transport.getFriendship({ accessToken })).friendFlag;
  } catch (err) {
    logSafeError("line/login friendship", err);
    return finish("temporary_failure");
  }
  if (!friend) return finish("not_friend");

  const { data: redeemed, error: redeemError } = await db().rpc("line_invite_redeem", { p_flow_id: flowId, p_destination_id: sub });
  if (redeemError) {
    logSafeError("line/login redeem", redeemError);
    return finish("temporary_failure");
  }
  const row = (redeemed as Array<{ outcome: FlowOutcome }>)[0];
  return { kind: "outcome", outcome: row.outcome, flowId };
}
