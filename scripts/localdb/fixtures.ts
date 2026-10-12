// ローカル DB のテスト用の店舗・予約通知の状態を作る。値はすべて架空のもの(実在の店舗・アカウントではない)。
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

export interface SalonFixture {
  salonId: string;
  userId: string;
  email: string;
}

export async function createSalon(sql: Sql, opts: { plan?: "reviews" | "salonpack"; name?: string; email?: string } = {}): Promise<SalonFixture> {
  const userId = randomUUID();
  const email = opts.email ?? `owner-${userId.slice(0, 8)}@example.test`;
  await sql`insert into auth.users (id, email) values (${userId}, ${email})`;
  const [profile] = await sql<{ id: string }[]>`select id from public.profiles where user_id = ${userId}`;
  const [salon] = await sql<{ id: string }[]>`
    insert into public.salons (owner_id, name, slug, plan)
    values (${profile.id}, ${opts.name ?? `テスト店舗 ${userId.slice(0, 4)}`}, ${`s-${userId.slice(0, 12)}`}, ${opts.plan ?? "salonpack"})
    returning id`;
  return { salonId: salon.id, userId, email };
}

export async function createOperator(sql: Sql, email = `ops-${randomUUID().slice(0, 8)}@example.test`): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, email) values (${userId}, ${email})`;
  await sql`insert into public.operator_admins (user_id, granted_by) values (${userId}, 'test')`;
  return userId;
}

/** 予約通知が稼働中の店舗(Google 連携・LINE の通知先・内部スイッチ ON・運用状態 active)。 */
export async function makeReservationActive(sql: Sql, salonId: string): Promise<{ lineConnectionId: string }> {
  const accountId = randomUUID();
  await sql`
    insert into public.google_accounts (id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv,
                                        refresh_token_tag, key_version, granted_scopes)
    values (${accountId}, 'client.test', ${`sub${accountId.slice(0, 8)}`}, 'inbox@example.test', 'c', 'i', 't', 'v1',
            array['https://www.googleapis.com/auth/gmail.readonly'])`;
  await sql`insert into public.salon_google_bindings (salon_id, feature, google_account_id, account_email)
            values (${salonId}, 'gmail', ${accountId}, 'inbox@example.test')`;
  await sql`insert into public.salon_feature_selections (salon_id, feature_key, selected)
            values (${salonId}, 'reservation_notifications', true)
            on conflict (salon_id, feature_key) do update set selected = true`;
  const [lc] = await sql<{ id: string }[]>`
    insert into public.line_connections (salon_id, destination_id, status, label)
    values (${salonId}, ${`U${salonId.replace(/-/g, "").slice(0, 16)}`}, 'connected', 'スタッフ')
    returning id`;
  await sql`
    insert into public.reservation_notification_operations (salon_id, state, mail_fetch_since, mail_fetch_since_reason, activated_at, activated_by)
    values (${salonId}, 'active', now() - interval '7 days', 'test', now() - interval '7 days', 'test')
    on conflict (salon_id) do update set state = 'active', mail_fetch_since = excluded.mail_fetch_since,
      activated_at = excluded.activated_at`;
  return { lineConnectionId: lc.id };
}

export async function addDelivery(
  sql: Sql,
  salonId: string,
  lineConnectionId: string,
  opts: { receivedAt?: Date } = {},
): Promise<string> {
  const [lc] = await sql<{ destination_id: string }[]>`select destination_id from public.line_connections where id = ${lineConnectionId}`;
  const [d] = await sql<{ id: string }[]>`
    insert into public.notification_deliveries (salon_id, provider_message_id, line_connection_id, event_type, line_text,
                                                destination_id, mail_received_at)
    values (${salonId}, ${`msg-${randomUUID()}`}, ${lineConnectionId}, 'new_reservation', '新しい予約(テスト)',
            ${lc.destination_id}, ${opts.receivedAt ?? new Date()})
    returning id`;
  return d.id;
}

export interface Claimed {
  id: string;
  claim_token: string;
}

export async function claim(sql: Sql, salonId: string, allowedPlans: string[] | null = null): Promise<Claimed | null> {
  const rows = await sql<Claimed[]>`select id, claim_token from public.notifications_claim_delivery_v2(${salonId}, ${allowedPlans})`;
  return rows[0] ?? null;
}

export async function beginSend(sql: Sql, c: Claimed, allowedPlans: string[] | null = null): Promise<{ decision: string; reason: string | null }> {
  const [row] = await sql<{ decision: string; reason: string | null }[]>`
    select decision, reason from public.notifications_begin_send(${c.id}, ${c.claim_token}, ${allowedPlans})`;
  return row;
}

export async function adminSave(
  sql: Sql,
  params: {
    actor: string;
    salonId: string;
    expectedVersion: number;
    expected: Record<string, unknown>;
    changes: Record<string, unknown>;
    note?: string | null;
  },
): Promise<{ result: string; version?: number; inflight_sends?: number }> {
  const [row] = await sql<{ r: { result: string; version?: number; inflight_sends?: number } }[]>`
    select public.admin_update_salon_entitlements(
      ${params.actor}, ${params.salonId}, ${params.expectedVersion}, ${sql.json(params.expected as never)},
      ${sql.json(params.changes as never)}, ${params.note ?? null}, ${randomUUID()}) as r`;
  return row.r;
}

export async function stateOf(sql: Sql, salonId: string): Promise<{ version: number; committed: Record<string, boolean> }> {
  const [row] = await sql<{ version: string; committed_entitled: Record<string, boolean> }[]>`
    select version, committed_entitled from public.salon_entitlement_state where salon_id = ${salonId}`;
  return { version: Number(row.version), committed: row.committed_entitled };
}

export async function openHolds(sql: Sql, salonId: string): Promise<string[]> {
  const rows = await sql<{ feature_key: string }[]>`
    select feature_key from public.salon_feature_holds where salon_id = ${salonId} and released_at is null order by feature_key`;
  return rows.map((r) => r.feature_key);
}

export async function openStops(sql: Sql, salonId: string): Promise<string[]> {
  const rows = await sql<{ kind: string }[]>`
    select kind from public.reservation_stop_intervals where salon_id = ${salonId} and ended_at is null order by kind`;
  return rows.map((r) => r.kind);
}
