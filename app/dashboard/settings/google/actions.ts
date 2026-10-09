"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { canAccessFeature } from "@/lib/access/featureAccess";
import { loadSetupContext } from "@/lib/features/setupContext";
import { resolveSelection } from "@/lib/features/featureState";
import { FEATURE_REGISTRY, type FeatureKey } from "@/lib/features/registry";
import { saveFeatureSelection } from "@/lib/features/selection";
import { listSalonGoogleBindings, unbindGoogleFeatures } from "@/lib/google/db/bindings";
import { GoogleConnectInputError, startGoogleConnect } from "@/lib/google/oauthFlow";
import { processGoogleRevocations } from "@/lib/google/revocations";
import { getGoogleFlowDeps } from "@/lib/google/runtime";
import { logSafeError } from "@/lib/google/safeError";
import { isGoogleFeature, type GoogleFeature } from "@/lib/google/scopes";
import type { OAuthPurpose } from "@/lib/google/db/oauthStates";

// Google連携の画面の操作。店舗はセッションから解決し、クライアントからは受け取らない。
// 3つの操作を分ける:
//   - 予約通知の利用を停止 / 届いた口コミの利用を停止(その機能だけ。共有の認可は取り消さない)
//   - Google連携をすべて解除(この店舗の結び付けを外す。どの店舗からも使われなくなった認可だけ取り消す)

const PURPOSES: OAuthPurpose[] = ["connect", "add_scope", "reauth", "switch_account"];

function featureKeyFor(google: GoogleFeature): FeatureKey {
  return FEATURE_REGISTRY.find((f) => f.googleFeature === google)!.key;
}

async function resolveContext() {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { salon, user };
}

export async function startGoogleConnectAction(formData: FormData): Promise<void> {
  const { salon, user } = await resolveContext();
  const features = String(formData.get("features") ?? "")
    .split(",")
    .filter(isGoogleFeature);
  const purposeRaw = String(formData.get("purpose") ?? "connect");
  const purpose = (PURPOSES as string[]).includes(purposeRaw) ? (purposeRaw as OAuthPurpose) : "connect";

  // 契約上利用でき、お客様がその機能を選んでいる場合だけ、その機能の権限を要求する。
  const ctx = await loadSetupContext(salon);
  const { selected } = resolveSelection(ctx);
  for (const feature of features) {
    const def = FEATURE_REGISTRY.find((f) => f.googleFeature === feature)!;
    if (!selected.has(def.key) || !(await canAccessFeature(salon, user.id, def.accessFeature))) {
      redirect("/dashboard/settings/google?google=feature_not_selected");
    }
  }

  // 再認証・権限追加は、接続中のアカウントと同じアカウントでだけ行う(違えばコールバックで拒否)。
  let expectedGoogleSub: string | null = null;
  let loginHint: string | null = null;
  if (purpose === "reauth" || purpose === "add_scope") {
    const bindings = await listSalonGoogleBindings(salon.id);
    const source =
      bindings.find((b) => features.includes(b.feature)) ?? (purpose === "add_scope" ? bindings[0] : undefined);
    if (!source) redirect("/dashboard/settings/google?google=not_connected");
    expectedGoogleSub = source.account.googleSub;
    loginHint = source.accountEmail ?? source.account.email;
  }

  let url: string;
  try {
    url = await startGoogleConnect(
      { salonId: salon.id, userId: user.id, features, purpose, expectedGoogleSub, loginHint, returnTo: "settings_google" },
      getGoogleFlowDeps()
    );
  } catch (error) {
    if (error instanceof GoogleConnectInputError) redirect("/dashboard/settings/google?google=not_available");
    logSafeError("google/start", error);
    redirect("/dashboard/settings/google?google=start_failed");
  }
  redirect(url);
}

/** その機能の利用を停止する(選択を OFF。共有の Google 認可は取り消さない)。 */
export async function stopFeatureAction(formData: FormData): Promise<void> {
  const { salon, user } = await resolveContext();
  const google = String(formData.get("feature") ?? "");
  if (!isGoogleFeature(google)) redirect("/dashboard/settings/google");
  const ctx = await loadSetupContext(salon);
  const { selected } = resolveSelection(ctx);
  const target = featureKeyFor(google);
  selected.delete(target);
  await saveFeatureSelection({ salonId: salon.id, userId: user.id, selected: [...selected] });
  if (google === "gbp") {
    // 口コミの利用停止: 口コミの結び付けだけを外す(予約メールの Gmail はそのまま)。
    await unbindGoogleFeatures({ salonId: salon.id, features: ["gbp"], userId: user.id, revokeIfUnreferenced: false });
  }
  revalidatePath("/dashboard/settings/google");
  revalidatePath("/dashboard");
  redirect(`/dashboard/settings/google?google=stopped_${google}`);
}

/**
 * Google連携をすべて解除する。この店舗の結び付けを外し、どの店舗・機能からも使われなくなった
 * アカウントだけ Google で許可を取り消す(Google の取り消しはそのアカウントの許可を全部取り消すため)。
 */
export async function disconnectAllGoogleAction(formData: FormData): Promise<void> {
  const { salon, user } = await resolveContext();
  if (formData.get("confirm") !== "yes") redirect("/dashboard/settings/google?google=confirm_required");
  const results = await unbindGoogleFeatures({ salonId: salon.id, features: ["gmail", "gbp"], userId: user.id, revokeIfUnreferenced: true });
  if (results.some((r) => r.revocationEnqueued)) {
    try {
      await processGoogleRevocations({ transport: getGoogleFlowDeps().transport });
    } catch (error) {
      // 取り消しは待ち行列に残り、後で再試行する。
      logSafeError("google/revocation", error);
    }
  }
  revalidatePath("/dashboard/settings/google");
  revalidatePath("/dashboard");
  redirect("/dashboard/settings/google?google=disconnected");
}
