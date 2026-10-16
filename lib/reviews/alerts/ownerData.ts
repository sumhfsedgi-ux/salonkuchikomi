import "server-only";
import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import { listPendingInvites, listRecipients, type PendingInvite } from "@/lib/notifications/recipients/db";
import { GBP_CONSENT_VERSION } from "@/lib/gbp/inbox";
import type { PushState, StopReason } from "@/lib/reviews/alerts/status";

// 口コミの設定タブ(自動確認・LINE 通知)の表示に使う値。店舗の id はセッションから解決したものだけを渡す。
// service role で読むが、どれも店舗の id で絞る(他店舗の値は返さない)。宛先(LINE のユーザー ID)は返さない。

export interface ReviewAlertRecipient {
  id: string;
  label: string;
  connected: boolean;
  reviewOn: boolean;
  onSince: string | null;
  changeLocked: boolean;
}

export interface ReviewAlertDeliveryRow {
  id: string;
  createdAt: string;
  recipientLabel: string;
  status: string;
  skipReason: string | null;
  retryStopped: boolean;
  inFlight: boolean;
}

export interface ReviewAlertPanelData {
  settings: { enabled: boolean; version: number; notifyFrom: string | null; stopReason: StopReason };
  consentOk: boolean;
  hasLocation: boolean;
  activeRecipients: number;
  autoSync: { lastSuccessAt: string | null; consecutiveFailures: number; authHold: boolean; pushState: PushState };
  recipients: ReviewAlertRecipient[];
  invites: PendingInvite[];
  recent: ReviewAlertDeliveryRow[];
}

type Row = Record<string, unknown>;

export async function loadReviewAlertPanel(salonId: string): Promise<ReviewAlertPanelData> {
  const db = getNotificationsSupabaseAdmin();
  const one = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`review alerts: ${fn}`);
    return data;
  };

  const [settingsRes, locationId, consentOk, activeRecipients, recipients, invites, prefsRes, connectionsRes, deliveriesRes] = await Promise.all([
    db.from("review_alert_settings").select("enabled, version, notify_from, stop_reason").eq("salon_id", salonId).maybeSingle(),
    one("review_alert_current_location", { p_salon_id: salonId }),
    one("gbp_has_connect_consent", { p_salon_id: salonId, p_version: GBP_CONSENT_VERSION }),
    one("review_alert_active_recipient_count", { p_salon_id: salonId }),
    listRecipients(salonId),
    listPendingInvites(salonId),
    db.from("review_alert_recipients").select("line_connection_id, enabled, on_since, registration_generation").eq("salon_id", salonId),
    db.from("line_connections").select("id, registration_generation").eq("salon_id", salonId).is("removed_at", null),
    db
      .from("review_alert_deliveries")
      .select("id, created_at, line_connection_id, status, skip_reason, retry_stopped_at, send_started_at")
      .eq("salon_id", salonId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const settingsRow = (settingsRes.data ?? null) as Row | null;
  const generations = new Map(((connectionsRes.data ?? []) as Row[]).map((r) => [String(r.id), Number(r.registration_generation)]));
  const prefs = new Map(((prefsRes.data ?? []) as Row[]).map((r) => [String(r.line_connection_id), r]));
  const list: ReviewAlertRecipient[] = recipients.map((r) => {
    const pref = prefs.get(r.id);
    const on = Boolean(pref?.enabled) && Number(pref?.registration_generation) === generations.get(r.id) && r.status === "connected";
    return {
      id: r.id,
      label: r.label ?? "スタッフ",
      connected: r.status === "connected",
      reviewOn: on,
      onSince: on ? (pref?.on_since as string) : null,
      changeLocked: r.changeLocked,
    };
  });
  const labels = new Map(list.map((r) => [r.id, r.label]));

  let autoSync: ReviewAlertPanelData["autoSync"] = { lastSuccessAt: null, consecutiveFailures: 0, authHold: false, pushState: null };
  if (typeof locationId === "string") {
    const [syncRes, locRes] = await Promise.all([
      db.from("gbp_auto_sync").select("last_success_at, consecutive_failures").eq("location_id", locationId).maybeSingle(),
      db.from("gbp_locations").select("account_name, google_account_id, google_accounts(token_generation)").eq("id", locationId).maybeSingle(),
    ]);
    const loc = (locRes.data ?? null) as Row | null;
    const account = loc?.google_accounts as Row | Row[] | null | undefined;
    const generation = Number((Array.isArray(account) ? account[0] : account)?.token_generation ?? -1);
    const [holdRes, regRes] = await Promise.all([
      loc ? db.from("gbp_auto_auth_holds").select("token_generation, failures").eq("google_account_id", String(loc.google_account_id)).maybeSingle() : null,
      loc ? db.from("gbp_notification_registrations").select("state").eq("account_name", String(loc.account_name)).maybeSingle() : null,
    ]);
    const hold = (holdRes?.data ?? null) as Row | null;
    const sync = (syncRes.data ?? null) as Row | null;
    autoSync = {
      lastSuccessAt: (sync?.last_success_at as string | null) ?? null,
      consecutiveFailures: Number(sync?.consecutive_failures ?? 0),
      authHold: Boolean(hold && Number(hold.token_generation) === generation && Number(hold.failures) >= 2),
      pushState: ((regRes?.data as Row | null)?.state as PushState) ?? null,
    };
  }

  return {
    settings: {
      enabled: Boolean(settingsRow?.enabled),
      version: Number(settingsRow?.version ?? 0),
      notifyFrom: (settingsRow?.notify_from as string | null) ?? null,
      stopReason: (settingsRow?.stop_reason as StopReason) ?? null,
    },
    consentOk: consentOk === true,
    hasLocation: typeof locationId === "string",
    activeRecipients: Number(activeRecipients ?? 0),
    autoSync,
    recipients: list,
    invites,
    recent: ((deliveriesRes.data ?? []) as Row[]).map((d) => ({
      id: String(d.id),
      createdAt: String(d.created_at),
      recipientLabel: labels.get(String(d.line_connection_id)) ?? "解除した通知先",
      status: String(d.status),
      skipReason: (d.skip_reason as string | null) ?? null,
      retryStopped: d.retry_stopped_at !== null && d.retry_stopped_at !== undefined,
      inFlight: d.send_started_at !== null && d.send_started_at !== undefined,
    })),
  };
}
