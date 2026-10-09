import { getGoogleOAuthConfig, isGoogleReviewsOAuthEnabled, isSimulatedGoogleEnabled, GOOGLE_CALLBACK_PATH } from "@/lib/google/config";
import type { GoogleFlowDeps } from "@/lib/google/oauthFlow";
import { getDevSimulatedGoogle } from "@/lib/google/simulated";
import { createHttpGoogleTransport } from "@/lib/google/transport";

// 実行時に使う Google との通信の組み立て。本番は HTTP。テスト用DBでの画面確認では擬似 Google
// (本番ビルドでは選ばれない)。

export const SIMULATED_AUTHORIZE_PATH = "/api/google/oauth/simulated-authorize";

export function getGoogleFlowDeps(): GoogleFlowDeps {
  if (isSimulatedGoogleEnabled()) {
    const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").origin;
    const clientId = process.env.GOOGLE_CLIENT_ID ?? "simulated-client.apps.invalid";
    const sim = getDevSimulatedGoogle(clientId);
    return {
      transport: sim.transport,
      config: { clientId, clientSecret: "simulated-secret", redirectUri: `${appUrl}${GOOGLE_CALLBACK_PATH}` },
      reviewsEnabled: isGoogleReviewsOAuthEnabled(),
      authorizationEndpoint: `${appUrl}${SIMULATED_AUTHORIZE_PATH}`,
    };
  }
  return {
    transport: createHttpGoogleTransport(),
    config: getGoogleOAuthConfig(),
    reviewsEnabled: isGoogleReviewsOAuthEnabled(),
  };
}
