import "server-only";
import type { SalonPlan } from "@/lib/access/plan";
import { isGoogleReviewsOAuthEnabled } from "@/lib/google/config";
import type { FeatureAccessInput } from "@/lib/features/access";
import { loadSalonEntitlements } from "@/lib/features/loadEntitlements";

/** サーバーで、店舗の契約・DB の利用権限・提供状況から判定の入力を作る(リクエストごとに DB を1回だけ読む)。 */
export async function loadFeatureAccessInput(salon: { id: string; plan: SalonPlan }): Promise<FeatureAccessInput> {
  return {
    plan: salon.plan,
    googleReviewsAvailable: isGoogleReviewsOAuthEnabled(),
    entitlements: await loadSalonEntitlements(salon.id),
  };
}
