import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isGoogleReviewsOAuthEnabled, isSimulatedGoogleEnabled } from "@/lib/google/config";
import { createGbpHttpApiClient } from "@/lib/gbp/apiClient";
import { createGoogleGbpAccess } from "@/lib/gbp/googleAccess";
import { createGbpInbox, type GbpInbox } from "@/lib/gbp/inbox";
import { getDevSimulatedGbp } from "@/lib/gbp/simulated";
import { simulatedGbpUsers } from "@/lib/gbp/dev/simulatedFixtures";
import { createRpcGbpStore, type RpcClient } from "@/lib/gbp/supabaseStore";
import type { GbpStore } from "@/lib/gbp/store";

// 届いた口コミのサーバー処理の組み立て。
//   ・GOOGLE_REVIEWS_OAUTH_ENABLED が無効なら、口コミの処理を作らない(null。画面・操作は「準備中」)。
//     店舗ごとの利用可否(DB の google_reviews)は、画面・Server Action の入口で別に確かめる(二重の停止)。
//   ・Google の API は、架空モード(テスト用DBの検証。本番ビルドでは選ばれない)なら架空の口コミの API、それ以外は本物。
//   ・期限切れの内容の削除(getGbpMaintenanceStore)は、利用可否・フラグに関係なく使える(計画 第2版 §3-9)。

/** 架空モードでだけ使う、口コミのキーの鍵(本番では REVIEW_KEY_HMAC_SECRET が必須)。 */
const SIMULATED_REVIEW_KEY_SECRET = "salonpack-simulated-review-key-secret-0000000000";

function rpcClient(): RpcClient {
  return getSupabaseAdmin() as unknown as RpcClient;
}

export function getReviewKeySecret(): string | null {
  const secret = process.env.REVIEW_KEY_HMAC_SECRET;
  if (secret && secret.length >= 32) return secret;
  return isSimulatedGoogleEnabled() ? SIMULATED_REVIEW_KEY_SECRET : null;
}

export function getGbpInbox(): GbpInbox | null {
  if (!isGoogleReviewsOAuthEnabled()) return null;
  const secret = getReviewKeySecret();
  if (!secret) {
    console.warn("gbp: REVIEW_KEY_HMAC_SECRET is not set; the review inbox is unavailable");
    return null;
  }
  const api = isSimulatedGoogleEnabled() ? getDevSimulatedGbp(() => simulatedGbpUsers()).api : createGbpHttpApiClient();
  return createGbpInbox({
    store: createRpcGbpStore(rpcClient()),
    api,
    access: createGoogleGbpAccess(),
    reviewKeySecret: secret,
    canWrite: () => isGoogleReviewsOAuthEnabled(),
  });
}

/** 期限切れの内容の削除だけに使う(利用可否・フラグ・Google の接続に関係なく使える。Google は呼ばない)。 */
export function getGbpMaintenanceStore(): GbpStore {
  return createRpcGbpStore(rpcClient());
}
