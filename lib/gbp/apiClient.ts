// Google ビジネスプロフィールの API の呼び出し。本物(createGbpHttpApiClient)と、どこにもつながない架空の Google
// (lib/gbp/simulated.ts。テスト用DBの画面確認とテスト)を差し替えられる。
//   ・アカウント:Account Management API v1 accounts.list
//   ・ロケーション:Business Information API v1 accounts.locations.list(readMask=name,title,storefrontAddress,metadata)
//   ・口コミ:v4 accounts.locations.reviews.list(pageSize 50、orderBy updateTime desc)/ reviews.get
//   ・返信:v4 reviews.updateReply(PUT {name}/reply。「A reply is created if one does not exist.」)/
//           deleteReply(DELETE {name}/reply)
//   ReviewReply の updateTime・reviewReplyState・policyViolation は Output only。応答に reviewReplyState が入るかは
//   資料に書かれていないので、無ければ「審査の状態は未確認」として扱う(公開済み・返信済みとは表示しない)。
//   条件付きの更新(ETag など)は無い。外で変わった返信との競合は、送る直前に取り直して比べる(lib/gbp/inbox.ts)。
// アクセストークン・口コミの中身はログに出さない。エラーは種類だけにする。
//
// 【403 の分類】403 を一律に「権限不足」にしない(計画 第2版 §3-B)。
//   scope_insufficient : エラーの詳細の理由が ACCESS_TOKEN_SCOPE_INSUFFICIENT / insufficientPermissions / insufficient_scope、
//                        または WWW-Authenticate に error="insufficient_scope"(lib/google/errors.ts の判定と同じ理由)
//   service_disabled   : SERVICE_DISABLED / accessNotConfigured(プロジェクトで API が有効でない。運営の設定の問題)
//   permission_denied  : 上のどれでもない PERMISSION_DENIED(その店舗の管理者でない、など)
//   forbidden          : 原因が分からない 403
// 実際の応答の理由の値は、許可された実店舗での読み取りの確認で確かめて見直す。

export interface GoogleAccount {
  /** accounts/{id} */
  name: string;
  accountName: string | null;
}

export interface GoogleLocation {
  /** locations/{id} */
  name: string;
  title: string;
  address: string | null;
  /** オーナー確認が済み、管理できるか(metadata.hasVoiceOfMerchant)。 */
  hasVoiceOfMerchant: boolean;
}

export type GoogleStarRating = "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "STAR_RATING_UNSPECIFIED";

export interface GoogleReviewJson {
  /** accounts/{a}/locations/{l}/reviews/{r} */
  name: string;
  reviewer?: { profilePhotoUrl?: string; displayName?: string; isAnonymous?: boolean };
  starRating?: GoogleStarRating;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: GoogleReviewReplyJson;
  reviewMediaItems?: { thumbnailUrl?: string; thumbnailLabel?: string; videoUrl?: string }[];
  reviewReplyUrl?: string;
}

/** ReviewReply(comment だけが入力。ほかは Output only)。 */
export interface GoogleReviewReplyJson {
  comment?: string;
  updateTime?: string;
  reviewReplyState?: string;
  policyViolation?: string;
}

export interface GoogleReviewPage {
  reviews: GoogleReviewJson[];
  averageRating: number | null;
  totalReviewCount: number | null;
  nextPageToken: string | null;
}

export type GbpApiErrorKind =
  | "unauthorized"
  | "scope_insufficient"
  | "service_disabled"
  | "permission_denied"
  | "forbidden"
  | "not_found"
  | "failed_precondition"
  /** 400 INVALID_ARGUMENT(続きのページの指定が受け付けられないときなど)。 */
  | "invalid_argument"
  | "rate_limited"
  | "unavailable"
  | "bad_response"
  /** つながらなかった・応答が途中で切れた。書き込みでは、反映されたかどうか分からない。 */
  | "network"
  /** 時間切れ。書き込みでは、反映されたかどうか分からない。 */
  | "timeout";

export class GbpApiError extends Error {
  constructor(readonly kind: GbpApiErrorKind) {
    super(`gbp api: ${kind}`);
    this.name = "GbpApiError";
  }
}

/** 403 系(どれも、Google は書き込みを受け付けていない)。 */
export const FORBIDDEN_KINDS: ReadonlySet<GbpApiErrorKind> = new Set(["scope_insufficient", "service_disabled", "permission_denied", "forbidden"]);

export interface GbpApiClient {
  readonly mode: "live" | "simulate";
  listAccounts(accessToken: string): Promise<GoogleAccount[]>;
  listLocations(accessToken: string, accountName: string): Promise<GoogleLocation[]>;
  listReviews(accessToken: string, accountName: string, locationName: string, pageToken: string | null): Promise<GoogleReviewPage>;
  getReview(accessToken: string, reviewName: string): Promise<GoogleReviewJson>;
  /** 返信を作る・置き換える(PUT)。応答は ReviewReply。 */
  updateReply(accessToken: string, reviewName: string, comment: string): Promise<GoogleReviewReplyJson>;
  /** 返信を消す(DELETE)。 */
  deleteReply(accessToken: string, reviewName: string): Promise<void>;
}

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const REVIEWS_API = "https://mybusiness.googleapis.com/v4";
const ACCOUNT_NAME = /^accounts\/[^/\s?#]+$/;
const LOCATION_NAME = /^locations\/[^/\s?#]+$/;
const REVIEW_NAME = /^accounts\/[^/\s?#]+\/locations\/[^/\s?#]+\/reviews\/[^/\s?#]+$/;

const SCOPE_REASONS = new Set(["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions", "insufficient_scope"]);
const SERVICE_DISABLED_REASONS = new Set(["SERVICE_DISABLED", "accessNotConfigured", "API_DISABLED"]);

function errorReasons(body: Record<string, unknown> | null): { status: string | null; reasons: Set<string> } {
  const reasons = new Set<string>();
  const error = body && typeof body.error === "object" && body.error ? (body.error as Record<string, unknown>) : null;
  for (const list of [error?.errors, error?.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === "object" && typeof (item as { reason?: unknown }).reason === "string") {
        reasons.add((item as { reason: string }).reason);
      }
    }
  }
  return { status: typeof error?.status === "string" ? error.status : null, reasons };
}

/** 403 を分類する(この判定だけを、連携の状態を変えるかどうかに使う。lib/gbp/inbox.ts)。 */
export function classifyForbidden(body: Record<string, unknown> | null, wwwAuthenticate: string | null): GbpApiErrorKind {
  const { status, reasons } = errorReasons(body);
  if ([...reasons].some((r) => SCOPE_REASONS.has(r)) || /error="?insufficient_scope"?/i.test(wwwAuthenticate ?? "")) {
    return "scope_insufficient";
  }
  if ([...reasons].some((r) => SERVICE_DISABLED_REASONS.has(r))) return "service_disabled";
  if (status === "PERMISSION_DENIED") return "permission_denied";
  return "forbidden";
}

export function errorKind(status: number, body: Record<string, unknown> | null, wwwAuthenticate: string | null = null): GbpApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return classifyForbidden(body, wwwAuthenticate);
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  const { status: grpcStatus } = errorReasons(body);
  if (grpcStatus === "FAILED_PRECONDITION" || JSON.stringify(body ?? {}).includes("FAILED_PRECONDITION")) return "failed_precondition";
  return status === 400 && (grpcStatus === "INVALID_ARGUMENT" || JSON.stringify(body ?? {}).includes("INVALID_ARGUMENT")) ? "invalid_argument" : "bad_response";
}

function formatAddress(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const a = value as { postalCode?: string; administrativeArea?: string; locality?: string; addressLines?: string[] };
  const parts = [a.postalCode ? `〒${a.postalCode}` : null, a.administrativeArea, a.locality, ...(a.addressLines ?? [])].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length ? parts.join(" ") : null;
}

/** 1回の呼び出しの時間切れ(返信の操作の処理権の長さも、これに合わせる。lib/gbp/inbox.ts)。 */
export const GBP_API_TIMEOUT_MS = 10_000;

export function createGbpHttpApiClient(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): GbpApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GBP_API_TIMEOUT_MS;

  async function request(method: "GET" | "PUT" | "DELETE", url: string, accessToken: string, payload?: unknown): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let body: Record<string, unknown> | null = null;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      try {
        const text = await res.text();
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
    } catch {
      throw new GbpApiError(controller.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new GbpApiError(errorKind(res.status, body, res.headers.get("www-authenticate")));
    return body;
  }

  async function getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
    const body = await request("GET", url, accessToken);
    if (!body || typeof body !== "object") throw new GbpApiError("bad_response");
    return body;
  }

  async function allPages<T>(firstUrl: (pageToken: string | null) => string, accessToken: string, pick: (body: Record<string, unknown>) => T[]) {
    const items: T[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 20; page++) {
      const body = await getJson(firstUrl(pageToken), accessToken);
      items.push(...pick(body));
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
      if (!pageToken) break;
    }
    return items;
  }

  return {
    mode: "live",

    listAccounts(accessToken) {
      return allPages(
        (token) => `${ACCOUNTS_API}/accounts?pageSize=20${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
        accessToken,
        (body) =>
          (Array.isArray(body.accounts) ? body.accounts : [])
            .filter((a): a is { name: string; accountName?: string } => typeof a?.name === "string" && ACCOUNT_NAME.test(a.name))
            .map((a) => ({ name: a.name, accountName: typeof a.accountName === "string" ? a.accountName : null })),
      );
    },

    listLocations(accessToken, accountName) {
      if (!ACCOUNT_NAME.test(accountName)) throw new GbpApiError("bad_response");
      return allPages(
        (token) =>
          `${INFO_API}/${accountName}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
        accessToken,
        (body) =>
          (Array.isArray(body.locations) ? body.locations : [])
            .filter((l): l is Record<string, unknown> & { name: string } => typeof l?.name === "string" && LOCATION_NAME.test(l.name))
            .map((l) => ({
              name: l.name,
              title: typeof l.title === "string" && l.title ? l.title : "(名前なし)",
              address: formatAddress(l.storefrontAddress),
              hasVoiceOfMerchant: (l.metadata as { hasVoiceOfMerchant?: unknown } | undefined)?.hasVoiceOfMerchant === true,
            })),
      );
    },

    async listReviews(accessToken, accountName, locationName, pageToken) {
      if (!ACCOUNT_NAME.test(accountName) || !LOCATION_NAME.test(locationName)) throw new GbpApiError("bad_response");
      const params = new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc" });
      if (pageToken) params.set("pageToken", pageToken);
      const body = await getJson(`${REVIEWS_API}/${accountName}/${locationName}/reviews?${params.toString()}`, accessToken);
      const reviews = (Array.isArray(body.reviews) ? body.reviews : []).filter(
        (r): r is GoogleReviewJson => typeof r?.name === "string" && REVIEW_NAME.test(r.name) && typeof r.createTime === "string",
      );
      return {
        reviews,
        averageRating: typeof body.averageRating === "number" ? body.averageRating : null,
        totalReviewCount: typeof body.totalReviewCount === "number" ? body.totalReviewCount : null,
        nextPageToken: typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null,
      };
    },

    async getReview(accessToken, reviewName) {
      if (!REVIEW_NAME.test(reviewName)) throw new GbpApiError("bad_response");
      const body = await getJson(`${REVIEWS_API}/${reviewName}`, accessToken);
      if (typeof body.name !== "string" || typeof body.createTime !== "string") throw new GbpApiError("bad_response");
      return body as unknown as GoogleReviewJson;
    },

    async updateReply(accessToken, reviewName, comment) {
      if (!REVIEW_NAME.test(reviewName)) throw new GbpApiError("bad_response");
      const body = await request("PUT", `${REVIEWS_API}/${reviewName}/reply`, accessToken, { comment });
      // 受け付けられた(2xx)。応答の形が想定と違っても、受け付けられたことは変わらない(内容は取り直して確かめる)。
      return body && typeof body === "object" ? (body as GoogleReviewReplyJson) : {};
    },

    async deleteReply(accessToken, reviewName) {
      if (!REVIEW_NAME.test(reviewName)) throw new GbpApiError("bad_response");
      await request("DELETE", `${REVIEWS_API}/${reviewName}/reply`, accessToken);
    },
  };
}
