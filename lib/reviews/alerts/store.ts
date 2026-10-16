import type { RpcClient } from "@/lib/gbp/supabaseStore";

// 口コミ 第2段階(新着の自動取得と LINE 通知)の DB(0033・0034 の関数)を呼ぶ。DB の関数だけを使い、表を直接は読み書きしない。
// 関数を呼ぶ部分(RpcClient)は差し替えられる:本番は Supabase のクライアント(service role)、
// ローカルの PostgreSQL のテストは scripts/localdb/rpcClient.ts。

type Row = Record<string, unknown>;

const rows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : data && typeof data === "object" ? [data as Row] : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export class ReviewAlertStoreError extends Error {
  constructor(
    readonly fn: string,
    readonly code: string | null,
  ) {
    super(`review alerts: ${fn} failed${code ? ` (${code})` : ""}`);
    this.name = "ReviewAlertStoreError";
  }
}

// ------------------------------------------------------------------
// 自動取得
// ------------------------------------------------------------------

export interface DueLocation {
  salonId: string;
  locationId: string;
  googleAccountId: string;
  tokenGeneration: number;
  /** 途中で区切った同期がある(続きから読む。最初から読み直す同期ではない)。 */
  runInProgress: boolean;
  /** Google の通知を受けて、取り込みを待っている。 */
  requested: boolean;
}

export type AutoSyncOutcome = "complete" | "partial" | "throttled" | "busy" | "inactive" | "failed";

export interface AutoSyncStore {
  dueLocations(consentVersion: string, limit: number): Promise<DueLocation[]>;
  /** 自動取得の開始を記録し、開始の時刻(DB の時刻)を返す。 */
  beginAutoSync(salonId: string, locationId: string): Promise<string>;
  finishAutoSync(input: {
    locationId: string;
    outcome: AutoSyncOutcome;
    attemptStartedAt: string;
    freshRun: boolean;
    nextSeconds: number;
    errorKind: string | null;
  }): Promise<void>;
  /** 自動取得での refresh token の失効の記録(ok で消す)。戻り値は同じトークンの世代での連続の回数。 */
  recordAuth(googleAccountId: string, tokenGeneration: number, ok: boolean): Promise<number>;
  recordRun(startedAt: string, stats: Record<string, number | string | boolean>): Promise<void>;
}

// ------------------------------------------------------------------
// LINE 通知
// ------------------------------------------------------------------

/** 配信に保存する送信内容(登録店舗名と SalonPack の確認用 URL だけ)。 */
export interface AlertMessageData {
  salonName: string;
  url: string;
}

export interface ClaimedAlertDelivery {
  id: string;
  claimToken: string;
  salonId: string;
  lineConnectionId: string;
}

export type AlertBeginSend =
  | { decision: "send"; destinationId: string; message: AlertMessageData; retryKey: string }
  | { decision: "skipped" | "released" | "expired" | "lost"; reason: string | null };

export type AlertFinishOutcome = "sent" | "failed" | "unknown" | "retry_wait";

export interface AlertDeliveryStore {
  pendingEvents(limit: number): Promise<{ id: string; salonId: string }[]>;
  /** notify / skipped:<理由> / already_decided / not_found */
  evaluate(eventId: string, baseUrl: string, consentVersion: string): Promise<string>;
  claim(): Promise<ClaimedAlertDelivery | null>;
  beginSend(delivery: ClaimedAlertDelivery, consentVersion: string): Promise<AlertBeginSend>;
  finish(input: {
    delivery: ClaimedAlertDelivery;
    outcome: AlertFinishOutcome;
    lineRequestId?: string | null;
    error?: string | null;
    retryAfterSeconds?: number | null;
  }): Promise<boolean>;
  releaseClaim(delivery: ClaimedAlertDelivery): Promise<boolean>;
  cancelSendStart(delivery: ClaimedAlertDelivery): Promise<boolean>;
  purge(): Promise<Record<string, number>>;
  sweepEntitlement(): Promise<number>;
}

export function parseAlertMessage(value: unknown): AlertMessageData | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Row;
  const salonName = str(v.salon_name);
  const url = str(v.url);
  if (salonName === null || url === null) return null;
  return { salonName, url };
}

export function createRpcReviewAlertStore(client: RpcClient): AutoSyncStore & AlertDeliveryStore {
  async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      const code = /(?:review_alert|gbp_auto):([a-z_]+)/.exec(error.message ?? "")?.[1] ?? error.code ?? null;
      throw new ReviewAlertStoreError(fn, code);
    }
    return data;
  }

  return {
    async dueLocations(consentVersion, limit) {
      return rows(await call("gbp_auto_due_locations", { p_consent_version: consentVersion, p_limit: limit })).map((r) => ({
        salonId: String(r.salon_id),
        locationId: String(r.location_id),
        googleAccountId: String(r.google_account_id),
        tokenGeneration: num(r.token_generation),
        runInProgress: r.run_in_progress === true,
        requested: r.requested === true,
      }));
    },

    async beginAutoSync(salonId, locationId) {
      const data = await call("gbp_auto_begin", { p_salon_id: salonId, p_location_id: locationId });
      return new Date(String(data)).toISOString();
    },

    async finishAutoSync(input) {
      await call("gbp_auto_finish", {
        p_location_id: input.locationId,
        p_outcome: input.outcome,
        p_attempt_started_at: input.attemptStartedAt,
        p_fresh_run: input.freshRun,
        p_next_seconds: Math.max(0, Math.min(86_400, Math.round(input.nextSeconds))),
        p_error_kind: input.errorKind,
      });
    },

    async recordAuth(googleAccountId, tokenGeneration, ok) {
      return num(await call("gbp_auto_auth_record", { p_google_account_id: googleAccountId, p_token_generation: tokenGeneration, p_ok: ok }));
    },

    async recordRun(startedAt, stats) {
      await call("gbp_auto_run_record", { p_started_at: startedAt, p_stats: stats });
    },

    async pendingEvents(limit) {
      return rows(await call("review_alert_pending_events", { p_limit: limit })).map((r) => ({ id: String(r.id), salonId: String(r.salon_id) }));
    },

    async evaluate(eventId, baseUrl, consentVersion) {
      return String(await call("review_alert_evaluate", { p_event_id: eventId, p_base_url: baseUrl, p_consent_version: consentVersion }));
    },

    async claim() {
      const [r] = rows(await call("review_alert_claim", {}));
      if (!r || !r.id) return null;
      return { id: String(r.id), claimToken: String(r.claim_token), salonId: String(r.salon_id), lineConnectionId: String(r.line_connection_id) };
    },

    async beginSend(delivery, consentVersion) {
      const [r] = rows(
        await call("review_alert_begin_send", { p_id: delivery.id, p_claim_token: delivery.claimToken, p_consent_version: consentVersion }),
      );
      const decision = str(r?.decision);
      if (decision === "send") {
        const message = parseAlertMessage(r!.message);
        const destinationId = str(r!.destination_id);
        const retryKey = str(r!.line_retry_key);
        if (message && destinationId && retryKey) return { decision: "send", destinationId, message, retryKey };
        // 想定外の形: 送らずに結果不明として扱わせない(送信を始めていないので取り消す)。
        return { decision: "lost", reason: "bad_row" };
      }
      if (decision === "skipped" || decision === "released" || decision === "expired" || decision === "lost") {
        return { decision, reason: str(r?.reason) };
      }
      return { decision: "lost", reason: "no_row" };
    },

    async finish({ delivery, outcome, lineRequestId, error, retryAfterSeconds }) {
      const data = await call("review_alert_finish", {
        p_id: delivery.id,
        p_claim_token: delivery.claimToken,
        p_outcome: outcome,
        p_line_request_id: lineRequestId ?? null,
        p_error: error ?? null,
        p_retry_after: retryAfterSeconds ? `${Math.round(retryAfterSeconds)} seconds` : null,
      });
      return data === true;
    },

    async releaseClaim(delivery) {
      return (await call("review_alert_release_claim", { p_id: delivery.id, p_claim_token: delivery.claimToken })) === true;
    },

    async cancelSendStart(delivery) {
      return (await call("review_alert_cancel_send_start", { p_id: delivery.id, p_claim_token: delivery.claimToken })) === true;
    },

    async purge() {
      const data = await call("review_alert_purge", {});
      const out: Record<string, number> = {};
      if (data && typeof data === "object") for (const [k, v] of Object.entries(data as Row)) out[k] = num(v);
      return out;
    },

    async sweepEntitlement() {
      return num(await call("review_alert_sweep_entitlement", {}));
    },
  };
}
