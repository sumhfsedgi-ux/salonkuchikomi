import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// LINE 通知先・招待の DB 操作(0023 の関数)。店舗の id は、呼び出し元がセッションから解決したもの
// (getCurrentSalon)だけを渡す。通知先・招待の id はクライアントから受け取るが、DB 関数の中で店舗と一致するかを
// 確かめる(他の店舗の通知先・招待は変更できない)。

export type RecipientOrigin = "legacy" | "invite" | "operator";

export interface Recipient {
  id: string;
  label: string | null;
  status: "connected" | "not_connected";
  newReservationEnabled: boolean;
  cancellationEnabled: boolean;
  linkedAt: string | null;
  origin: RecipientOrigin;
  /** 切り替え待ちの間、旧側で使われている通知先は ON/OFF・解除を受け付けない。 */
  changeLocked: boolean;
}

export interface PendingInvite {
  id: string;
  displayName: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

function db() {
  return getNotificationsSupabaseAdmin();
}

export async function listRecipients(salonId: string): Promise<Recipient[]> {
  const { data, error } = await db().rpc("line_recipient_list", { p_salon_id: salonId });
  if (error) throw new Error("通知先の取得に失敗しました。");
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    label: (r.label as string | null) ?? null,
    status: r.status as Recipient["status"],
    newReservationEnabled: Boolean(r.new_reservation_enabled),
    cancellationEnabled: Boolean(r.cancellation_enabled),
    linkedAt: (r.linked_at as string | null) ?? null,
    origin: r.origin as RecipientOrigin,
    changeLocked: Boolean(r.change_locked),
  }));
}

export async function listPendingInvites(salonId: string): Promise<PendingInvite[]> {
  const { data, error } = await db().rpc("line_invite_list", { p_salon_id: salonId });
  if (error) throw new Error("招待の取得に失敗しました。");
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    displayName: r.display_name as string,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    expired: Boolean(r.expired),
  }));
}

/** 切り替え待ち(旧サービスがまだ通知している)の間は、全体スイッチを変更できない。 */
export async function isSalonLockedForCutover(salonId: string): Promise<boolean> {
  const { data, error } = await db().rpc("salon_settings_locked_for_cutover", { p_salon_id: salonId });
  if (error) throw new Error("設定の状態の取得に失敗しました。");
  return data === true;
}

export async function createInvite(params: { salonId: string; tokenHash: string; displayName: string; userId: string }) {
  const { data, error } = await db().rpc("line_invite_create", {
    p_salon_id: params.salonId,
    p_token_hash: params.tokenHash,
    p_display_name: params.displayName,
    p_by: params.userId,
  });
  if (error) {
    if (error.message?.includes("line_invite:too_many_active")) return { ok: false as const, reason: "too_many" as const };
    throw new Error("招待の作成に失敗しました。");
  }
  const row = (data as Array<{ id: string; expires_at: string }>)[0];
  return { ok: true as const, id: row.id, expiresAt: row.expires_at };
}

export async function revokeInvite(salonId: string, inviteId: string, userId: string): Promise<string> {
  const { data, error } = await db().rpc("line_invite_revoke", { p_salon_id: salonId, p_invite_id: inviteId, p_by: userId });
  if (error) throw new Error("招待の取消に失敗しました。");
  return data as string;
}

export async function reissueInvite(params: { salonId: string; inviteId: string; tokenHash: string; userId: string }) {
  const { data, error } = await db().rpc("line_invite_reissue", {
    p_salon_id: params.salonId,
    p_invite_id: params.inviteId,
    p_new_token_hash: params.tokenHash,
    p_by: params.userId,
  });
  if (error) {
    if (error.message?.includes("line_invite:too_many_active")) return { outcome: "too_many" as const };
    throw new Error("招待の再発行に失敗しました。");
  }
  const row = (data as Array<{ outcome: string; id: string | null; expires_at: string | null; display_name: string | null }>)[0];
  return { outcome: row.outcome, id: row.id, expiresAt: row.expires_at, displayName: row.display_name };
}

export async function updateRecipient(params: {
  salonId: string;
  connectionId: string;
  newReservationEnabled?: boolean;
  cancellationEnabled?: boolean;
  label?: string;
}): Promise<"updated" | "locked" | "not_found" | "invalid_label"> {
  const { data, error } = await db().rpc("line_recipient_update", {
    p_salon_id: params.salonId,
    p_connection_id: params.connectionId,
    p_new_reservation: params.newReservationEnabled ?? null,
    p_cancellation: params.cancellationEnabled ?? null,
    p_label: params.label ?? null,
  });
  if (error) throw new Error("通知先の設定の保存に失敗しました。");
  return data as "updated" | "locked" | "not_found" | "invalid_label";
}

export async function removeRecipient(salonId: string, connectionId: string, by: string): Promise<"removed" | "locked" | "not_found"> {
  const { data, error } = await db().rpc("line_recipient_remove", { p_salon_id: salonId, p_connection_id: connectionId, p_by: by });
  if (error) throw new Error("通知先の解除に失敗しました。");
  return data as "removed" | "locked" | "not_found";
}

export async function setMasterEnabled(salonId: string, enabled: boolean): Promise<"updated" | "locked"> {
  const { data, error } = await db().rpc("notification_settings_set_master", { p_salon_id: salonId, p_enabled: enabled });
  if (error) throw new Error("予約通知の設定の保存に失敗しました。");
  return data as "updated" | "locked";
}
