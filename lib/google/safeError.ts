// Google / googleapis / gaxios のエラーをログへ出すときの要約。
// ライブラリのエラーは、メッセージや request config に認可コード・client_secret・
// code_verifier・Authorization ヘッダー・id_token そのものを含むことがある
// (例: google-auth-library の 'Invalid token signature: <jwt>')。
// そのため、ここではステータス番号と、許可した形の理由コードだけを取り出す。

export interface SafeErrorSummary {
  name: string;
  status?: number;
  reason?: string;
}

const REASON_PATTERN = /^[a-zA-Z_]{1,60}$/;

function pickReason(value: unknown): string | undefined {
  return typeof value === "string" && REASON_PATTERN.test(value) ? value : undefined;
}

export function summarizeError(error: unknown): SafeErrorSummary {
  if (!error || typeof error !== "object") return { name: typeof error };
  const e = error as Record<string, unknown>;
  const name = typeof e.name === "string" && /^[A-Za-z]{1,60}$/.test(e.name) ? e.name : "Error";
  const response = (e.response && typeof e.response === "object" ? e.response : undefined) as
    | Record<string, unknown>
    | undefined;
  const statusCandidate = e.status ?? response?.status ?? e.code;
  const status = typeof statusCandidate === "number" && statusCandidate >= 100 && statusCandidate < 600 ? statusCandidate : undefined;
  const data = (response?.data && typeof response.data === "object" ? response.data : undefined) as
    | Record<string, unknown>
    | undefined;
  const nested = (data?.error && typeof data.error === "object" ? data.error : undefined) as
    | Record<string, unknown>
    | undefined;
  const firstDetail = Array.isArray(nested?.errors) ? (nested?.errors as Array<Record<string, unknown>>)[0] : undefined;
  const reason =
    pickReason(e.kind) ??
    pickReason(e.oauthError) ??
    pickReason(data?.error) ??
    pickReason(firstDetail?.reason) ??
    pickReason(nested?.status) ??
    (typeof e.code === "string" ? pickReason(e.code) : undefined);
  return { name, status, reason };
}

export function logSafeError(context: string, error: unknown): void {
  console.error(`[${context}]`, summarizeError(error));
}
