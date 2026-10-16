import "server-only";
import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import { pushMessages } from "@/lib/notifications/line/LineClient";
import { resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";
import { GBP_CONSENT_VERSION } from "@/lib/gbp/inbox";
import { getGbpAutoSyncInbox } from "@/lib/gbp/runtime";
import type { RpcClient } from "@/lib/gbp/supabaseStore";
import { isAutoSyncEnabled, isReviewAlertsEnabled, reviewAlertBaseUrl } from "@/lib/reviews/alerts/config";
import { lineQuotaAllowsReviewAlerts } from "@/lib/reviews/alerts/lineQuota";
import { buildReviewAlertMessage } from "@/lib/reviews/alerts/message";
import { createRpcReviewAlertStore } from "@/lib/reviews/alerts/store";
import type { ReviewTickDeps } from "@/lib/reviews/alerts/tick";

// 口コミ 第2段階の定期処理の組み立て(本番の部品)。DB は service role のクライアント(定期処理の残り時間で問い合わせを打ち切る)。

export function getReviewAlertStore() {
  return createRpcReviewAlertStore(getNotificationsSupabaseAdmin() as unknown as RpcClient);
}

export function getReviewTickDeps(): ReviewTickDeps {
  const policy = resolveLineSendPolicy();
  return {
    store: getReviewAlertStore(),
    inbox: getGbpAutoSyncInbox(),
    flags: { autoSync: isAutoSyncEnabled(), alerts: isReviewAlertsEnabled() },
    baseUrl: reviewAlertBaseUrl(),
    consentVersion: GBP_CONSENT_VERSION,
    send: (destinationId, message, retryKey, options) => pushMessages(destinationId, [buildReviewAlertMessage(message)], retryKey, options),
    // 実際に送る環境だけ、月の残り通数を確かめる(送らない環境では LINE を呼ばない)。
    quotaAllows: policy.mode === "live" || policy.mode === "verify" ? () => lineQuotaAllowsReviewAlerts() : undefined,
  };
}
