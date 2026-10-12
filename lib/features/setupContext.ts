import "server-only";
import { getNotificationsSupabaseAdmin as getServiceRoleClient } from "@/lib/notifications/admin";
import { isGoogleReviewsOAuthEnabled } from "@/lib/google/config";
import { listSalonGoogleBindings } from "@/lib/google/db/bindings";
import { hasScopeFor } from "@/lib/google/scopes";
import { isLineInviteAvailable } from "@/lib/notifications/line/login/config";
import type { OwnerSalon } from "@/lib/types";
import type { GoogleConnectionSnapshot, ReservationOpsState, SetupContext } from "@/lib/features/featureState";

// 機能の状態判定(lib/features/featureState.ts)に渡す材料を1か所で集める。
// salon は呼び出し元が getCurrentSalon() で解決したもの(クライアントから受け取らない)。

export async function loadSetupContext(salon: Pick<OwnerSalon, "id" | "plan" | "onboardingCompleted" | "googleReviewUrl">): Promise<SetupContext> {
  const supabase = getServiceRoleClient();
  const [reservationSwitch, survey, salonSettings, lines, ops, bindings, master, scan] = await Promise.all([
    // 予約通知の内部スイッチだけを読む(ほかの機能の行は、お客様が機能を選んでいた頃の記録で、判定には使わない)。
    supabase
      .from("salon_feature_selections")
      .select("selected, updated_at")
      .eq("salon_id", salon.id)
      .eq("feature_key", "reservation_notifications")
      .maybeSingle(),
    supabase.from("surveys").select("id").eq("salon_id", salon.id).eq("is_active", true).limit(1),
    supabase.from("salon_settings").select("main_menu").eq("salon_id", salon.id).maybeSingle(),
    supabase.from("line_connections").select("status, destination_id, removed_at").eq("salon_id", salon.id),
    supabase
      .from("reservation_notification_operations")
      .select("state, legacy_source, pause_reason, activated_at")
      .eq("salon_id", salon.id)
      .maybeSingle(),
    listSalonGoogleBindings(salon.id),
    supabase.from("notification_settings").select("master_enabled").eq("salon_id", salon.id).maybeSingle(),
    supabase.from("gmail_scan_state").select("last_tick_at").eq("salon_id", salon.id).maybeSingle(),
  ]);
  for (const result of [reservationSwitch, survey, lines, ops, master, scan]) {
    if (result.error) throw new Error("機能の設定状況の取得に失敗しました。");
  }
  const switchRow = reservationSwitch.data as { selected: boolean; updated_at: string } | null;

  // salon_settings はブログ機能の表(blog-app から移植)。無い環境でも他の機能の判定を止めない。
  const mainMenu = salonSettings.error ? null : (salonSettings.data as { main_menu?: unknown } | null)?.main_menu;
  const hasBlogSettings = Array.isArray(mainMenu) ? mainMenu.length > 0 : typeof mainMenu === "string" && mainMenu.trim().length > 0;

  const lineRows = (lines.data ?? []) as Array<{ status: string; destination_id: string | null; removed_at: string | null }>;
  const gmailBinding = bindings.find((b) => b.feature === "gmail");
  const gbpBinding = bindings.find((b) => b.feature === "gbp");
  const snapshot = (binding: typeof gmailBinding, feature: "gmail" | "gbp"): GoogleConnectionSnapshot => ({
    bound: Boolean(binding),
    authState: binding?.account.authState ?? null,
    scopeGranted: binding ? hasScopeFor(binding.account.grantedScopes, feature) && !binding.scopeMissingSince : false,
    scopeMissing: Boolean(binding?.scopeMissingSince),
    email: binding?.accountEmail ?? binding?.account.email ?? null,
    selectionState: feature === "gbp" ? (binding?.gbpSelectionState ?? null) : undefined,
  });
  const opsRow = ops.data as { state: string; legacy_source: string | null; pause_reason: string | null; activated_at: string | null } | null;

  return {
    plan: salon.plan,
    reservationSwitch: switchRow ? { selected: switchRow.selected, updatedAt: switchRow.updated_at } : null,
    hasActiveSurvey: (survey.data ?? []).length > 0,
    onboardingCompleted: salon.onboardingCompleted,
    googleReviewUrl: salon.googleReviewUrl,
    hasBlogSettings,
    lineRecipientCount: lineRows.filter((r) => r.status === "connected" && r.destination_id && !r.removed_at).length,
    gmail: snapshot(gmailBinding, "gmail"),
    gbp: snapshot(gbpBinding, "gbp"),
    reservationOps: opsRow
      ? {
          state: opsRow.state as ReservationOpsState,
          legacy: Boolean(opsRow.legacy_source),
          pauseReason: opsRow.pause_reason,
          activatedAt: opsRow.activated_at,
          lastMailCheckAt: (scan.data as { last_tick_at: string | null } | null)?.last_tick_at ?? null,
        }
      : null,
    masterEnabled: (master.data as { master_enabled: boolean } | null)?.master_enabled ?? true,
    lineInvitesAvailable: isLineInviteAvailable(),
    googleReviewsAvailable: isGoogleReviewsOAuthEnabled(),
  };
}
