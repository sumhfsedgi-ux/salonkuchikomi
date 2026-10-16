import "server-only";
import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import { GBP_CONSENT_VERSION } from "@/lib/gbp/inbox";

// 口コミの設定タブの操作(0033 の関数)。店舗の id・ユーザーの id は、呼び出し元がセッションから解決したものだけを
// 渡す(lib/googleReviews/access.ts)。通知先の id はクライアントから受け取るが、DB 関数の中で店舗と一致するかを確かめる。

export type StartOutcome = "started" | "changed" | "not_entitled" | "consent_required" | "not_ready" | "no_recipients";
export type SetRecipientOutcome = "updated" | "unchanged" | "not_found";

function db() {
  return getNotificationsSupabaseAdmin();
}

/** LINE 通知を開始・再開する。画面で読んだ版(version)のときだけ書く。 */
export async function startReviewAlerts(salonId: string, userId: string, expectedVersion: number): Promise<StartOutcome> {
  const { data, error } = await db().rpc("review_alert_start", {
    p_salon_id: salonId,
    p_user_id: userId,
    p_expected_version: expectedVersion,
    p_consent_version: GBP_CONSENT_VERSION,
  });
  if (error) throw new Error("review alerts: start");
  return data as StartOutcome;
}

/** LINE 通知を停止する。送信を始めていて取り消せない件数(in_flight)を返す。 */
export async function stopReviewAlerts(salonId: string, userId: string): Promise<{ outcome: "stopped" | "already_stopped"; inFlight: number }> {
  const { data, error } = await db().rpc("review_alert_stop", { p_salon_id: salonId, p_user_id: userId });
  if (error) throw new Error("review alerts: stop");
  const row = (data as Array<{ outcome: string; in_flight: number }> | null)?.[0];
  return { outcome: row?.outcome === "stopped" ? "stopped" : "already_stopped", inFlight: Number(row?.in_flight ?? 0) };
}

/** 通知先ごとの口コミ通知の ON/OFF。 */
export async function setReviewRecipient(salonId: string, connectionId: string, enabled: boolean, userId: string): Promise<SetRecipientOutcome> {
  const { data, error } = await db().rpc("review_alert_set_recipient", {
    p_salon_id: salonId,
    p_line_connection_id: connectionId,
    p_enabled: enabled,
    p_user_id: userId,
  });
  if (error) throw new Error("review alerts: set recipient");
  return data as SetRecipientOutcome;
}

/** テスト通知の連打を防ぐ(直前に送っていれば false)。 */
export async function takeReviewAlertTestSlot(salonId: string): Promise<boolean> {
  const { data, error } = await db().rpc("review_alert_test_slot", { p_salon_id: salonId });
  if (error) throw new Error("review alerts: test slot");
  return data === true;
}

/** 口コミ通知が ON で、今送れる通知先(テスト通知の宛先)。宛先の値はサーバーの中だけで使う。 */
export async function reviewAlertTestDestinations(salonId: string): Promise<Array<{ id: string; destinationId: string }>> {
  const [prefs, connections] = await Promise.all([
    db().from("review_alert_recipients").select("line_connection_id, registration_generation").eq("salon_id", salonId).eq("enabled", true),
    db()
      .from("line_connections")
      .select("id, destination_id, registration_generation")
      .eq("salon_id", salonId)
      .eq("status", "connected")
      .is("removed_at", null),
  ]);
  if (prefs.error || connections.error) throw new Error("review alerts: test destinations");
  const on = new Map((prefs.data ?? []).map((r) => [String(r.line_connection_id), Number(r.registration_generation)]));
  return (connections.data ?? [])
    .filter((c) => c.destination_id && on.get(String(c.id)) === Number(c.registration_generation))
    .map((c) => ({ id: String(c.id), destinationId: String(c.destination_id) }));
}
