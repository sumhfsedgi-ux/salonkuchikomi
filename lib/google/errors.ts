import { GoogleOAuthError } from "@/lib/google/transport";

// Google の呼び出しで起きたエラーの分類。
//   invalid_grant       保存した refresh token が無効(取り消し・失効)。連続した場合だけ再接続を案内する
//   insufficient_scope  その機能に必要な権限が無い(その機能だけ再接続・権限追加が必要)
//   config              クライアントID・シークレット等の設定の問題(お客様の再接続では直らない。運営へ警告)
//   transient           通信障害・一時的な失敗(再接続を求めない。次回そのまま再試行)
export type GoogleErrorClass = "invalid_grant" | "insufficient_scope" | "config" | "transient";

const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficient_scope"]);

export function classifyGoogleError(error: unknown): GoogleErrorClass {
  if (error instanceof GoogleOAuthError) {
    if (error.kind === "invalid_grant") return "invalid_grant";
    if (error.kind === "invalid_client" || error.kind === "rejected" || error.kind === "bad_response") return "config";
    return "transient";
  }
  if (!error || typeof error !== "object") return "transient";
  const e = error as Record<string, unknown>;
  const response = (e.response && typeof e.response === "object" ? e.response : undefined) as Record<string, unknown> | undefined;
  const status = typeof response?.status === "number" ? response.status : typeof e.status === "number" ? e.status : undefined;
  const data = (response?.data && typeof response.data === "object" ? response.data : undefined) as Record<string, unknown> | undefined;
  const topError = typeof data?.error === "string" ? data.error : undefined;
  const nested = (data?.error && typeof data.error === "object" ? data.error : undefined) as Record<string, unknown> | undefined;
  const reasons = new Set<string>();
  if (Array.isArray(nested?.errors)) {
    for (const item of nested!.errors as Array<Record<string, unknown>>) if (typeof item.reason === "string") reasons.add(item.reason);
  }
  if (Array.isArray(nested?.details)) {
    for (const item of nested!.details as Array<Record<string, unknown>>) if (typeof item.reason === "string") reasons.add(item.reason);
  }

  if (topError === "invalid_grant") return "invalid_grant";
  if (topError === "invalid_client" || topError === "unauthorized_client") return "config";
  if (status === 403 && [...reasons].some((r) => SCOPE_REASONS.has(r))) return "insufficient_scope";
  return "transient";
}
