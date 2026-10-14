// ローカル DB のテスト用の店舗・予約通知の状態を作る。値はすべて架空のもの(実在の店舗・アカウントではない)。
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

export interface SalonFixture {
  salonId: string;
  userId: string;
  email: string;
}

export type ServiceStatus = "pending" | "complimentary" | "test";

/** その DB に列・表があるか(0025 の前の DB でも同じ fixture を使うため)。 */
async function hasColumn(sql: Sql, table: string, column: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = ${table} and column_name = ${column}) as ok`;
  return row.ok;
}
async function hasTable(sql: Sql, table: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`select to_regclass(${"public." + table}) is not null as ok`;
  return row.ok;
}

/**
 * 既存のオーナーと同じ状態の店舗(メール確認済み・本人確認は legacy)。0025 のあとの DB では、利用区分も入れる
 * (既定は complimentary。後から UPDATE すると版数・履歴が増えるため、INSERT で直接入れる)。
 */
export async function createSalon(
  sql: Sql,
  opts: { plan?: "reviews" | "salonpack"; name?: string; email?: string; serviceStatus?: ServiceStatus; verified?: boolean } = {},
): Promise<SalonFixture> {
  const userId = randomUUID();
  const email = opts.email ?? `owner-${userId.slice(0, 8)}@example.test`;
  await sql`insert into auth.users (id, email, email_confirmed_at) values (${userId}, ${email}, now())`;
  const [profile] = await sql<{ id: string }[]>`select id from public.profiles where user_id = ${userId}`;
  const name = opts.name ?? `テスト店舗 ${userId.slice(0, 4)}`;
  const slug = `s-${userId.slice(0, 12)}`;
  const plan = opts.plan ?? "salonpack";
  const [salon] = (await hasColumn(sql, "salons", "service_status"))
    ? await sql<{ id: string }[]>`
        insert into public.salons (owner_id, name, slug, plan, service_status)
        values (${profile.id}, ${name}, ${slug}, ${plan}, ${opts.serviceStatus ?? "complimentary"})
        returning id`
    : await sql<{ id: string }[]>`
        insert into public.salons (owner_id, name, slug, plan)
        values (${profile.id}, ${name}, ${slug}, ${plan})
        returning id`;
  if (opts.verified !== false && (await hasTable(sql, "account_verifications"))) {
    await sql`insert into public.account_verifications (user_id, method) values (${userId}, 'legacy') on conflict (user_id) do nothing`;
  }
  return { salonId: salon.id, userId, email };
}

/**
 * Supabase Auth のセッションを1つ作り、PostgREST と同じ request.jwt.claims の値(JSON の文字列)を返す。
 * amr は認証方法(password / otp / invite / magiclink / recovery など)。createdAt で作成日時を指定できる。
 */
export async function createSession(
  sql: Sql,
  userId: string,
  opts: { amr?: string[]; createdAt?: Date; notAfter?: Date | null } = {},
): Promise<{ sessionId: string; claims: string }> {
  const sessionId = randomUUID();
  // 作成日時は、指定が無ければ DB の時刻(本人確認の記録の verified_at と同じ時計)にする。
  await sql`insert into auth.sessions (id, user_id, created_at, not_after)
            values (${sessionId}, ${userId}, coalesce(${opts.createdAt ?? null}::timestamptz, clock_timestamp()), ${opts.notAfter ?? null})`;
  for (const method of opts.amr ?? ["password"]) {
    await sql`insert into auth.mfa_amr_claims (session_id, authentication_method) values (${sessionId}, ${method})`;
  }
  return { sessionId, claims: JSON.stringify({ sub: userId, session_id: sessionId, role: "authenticated" }) };
}

export async function createOperator(sql: Sql, email = `ops-${randomUUID().slice(0, 8)}@example.test`): Promise<string> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, email, email_confirmed_at) values (${userId}, ${email}, now())`;
  if (await hasTable(sql, "account_verifications")) {
    await sql`insert into public.account_verifications (user_id, method) values (${userId}, 'legacy') on conflict (user_id) do nothing`;
  }
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
