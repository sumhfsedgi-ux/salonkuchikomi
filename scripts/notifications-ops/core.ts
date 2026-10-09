import type postgres from "postgres";
import { foldAllStaffSettings, type HmailStaffSettings } from "../migrateHmailSettingsFold";
import { buildRollbackPlan, reconcileEmail, summarize, type HmailStaffEmailState } from "../legacyReconcile";
import {
  canonicalMailbox,
  describeStaffSetProblem,
  validateLegacyStaffSet,
  type LegacyMapping,
  type LegacyStaffFacts,
} from "../legacyStaffSet";

// 予約通知の運用・旧サービス(hmail)からの切り替えの処理の本体(CLI: scripts/reservation-notifications-ops.ts、
// scripts/migrate-hmail-notifications.ts)。テスト用DBでは、旧側のスキーマ名を差し替えて検証する
// (scripts/testdb/cutover.test.ts。テスト用DBに hmail という名前のスキーマは作らない)。
//
// 原則:
//   - 既定は確認だけ(書き込まない)。書き込みは apply=true のときだけ。旧側(hmail)への書き込みは
//     さらに approveHmailWrite=true が必要(その場での明示的な承認)。
//   - 旧側の停止は、接続の削除や Google 認可の取り消しではなく、スタッフ全員分の行の状態の変更で行う。
//   - 時間の経過だけで停止を確認済みにしない。
//   - 秘密値・トークン・予約本文・個人情報をログに出さない(件数・ID・状態だけ)。

type Sql = postgres.Sql;
export type Log = (line: string) => void;

export class OpsError extends Error {}

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
export const LEGACY_STOPPED_STATUS = "migrated_to_salonpack";

function assertSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new OpsError(`スキーマ名が正しくありません: ${schema}`);
  return schema;
}

interface OpsRow {
  salon_id: string;
  state: string;
  legacy_source: string | null;
  legacy_schema: string;
  legacy_stop_confirmed_at: Date | null;
  accepted_reconciliation_id: string | null;
  mail_fetch_since: Date | null;
  activated_at: Date | null;
}

async function loadOps(sql: Sql, salonId: string): Promise<OpsRow> {
  const [ops] = await sql<OpsRow[]>`
    select salon_id, state, legacy_source, legacy_schema, legacy_stop_confirmed_at, accepted_reconciliation_id,
           mail_fetch_since, activated_at
      from public.reservation_notification_operations where salon_id = ${salonId}`;
  if (!ops) throw new OpsError("この店舗の予約通知の運用状態がありません(先に static の移行を実行してください)。");
  return ops;
}

async function legacyStaffIds(sql: Sql, salonId: string): Promise<string[]> {
  const rows = await sql<{ legacy_salon_id: string }[]>`
    select legacy_salon_id from public.legacy_cutover_snapshots where salon_id = ${salonId} order by legacy_salon_id`;
  return rows.map((r) => r.legacy_salon_id);
}

// ------------------------------------------------------------------
// 対応表(新側の店舗 ↔ 旧側の予約受信用 Gmail ↔ スタッフの人数)と、スタッフの集合の確認
// ------------------------------------------------------------------

export interface LegacyCheck {
  state: "not_legacy" | "stopped" | "active" | "unknown";
  reason: string | null;
  driftReason: string | null;
  legacyMailbox: string | null;
  expectedStaffCount: number | null;
  registeredIds: string[];
  unregisteredIds: string[];
  missingIds: string[];
  mailboxMismatchIds: string[];
  activeIds: string[];
}

/** DB の reservation_ops_legacy_check(停止確認・開始・監視と同じ判定)。 */
export async function legacyCheck(sql: Sql, salonId: string): Promise<LegacyCheck> {
  const [row] = await sql<Array<Record<string, unknown>>>`select * from public.reservation_ops_legacy_check(${salonId}::uuid)`;
  const arr = (v: unknown) => (v as string[] | null) ?? [];
  return {
    state: row.state as LegacyCheck["state"],
    reason: (row.reason as string | null) ?? null,
    driftReason: (row.drift_reason as string | null) ?? null,
    legacyMailbox: (row.legacy_mailbox as string | null) ?? null,
    expectedStaffCount: (row.expected_staff_count as number | null) ?? null,
    registeredIds: arr(row.registered_ids),
    unregisteredIds: arr(row.unregistered_ids),
    missingIds: arr(row.missing_ids),
    mailboxMismatchIds: arr(row.mailbox_mismatch_ids),
    activeIds: arr(row.active_ids),
  };
}

const DRIFT_MESSAGES: Record<string, string> = {
  no_mapping: "対応表に登録がありません",
  no_registered_staff: "スタッフが登録されていません",
  legacy_unreadable: "旧側の表を読めません(権限・スキーマ)",
  unregistered_legacy_rows: "登録のあとに、同じ予約受信用 Gmail の旧側のスタッフ行が増えています",
  registered_rows_missing: "登録したスタッフの旧側の行がありません",
  mailbox_changed: "登録したスタッフの予約受信用 Gmail が変わっています",
  staff_count_mismatch: "スタッフの人数が対応表と違います",
};

function describeDrift(check: LegacyCheck): string {
  const ids = [...check.unregisteredIds, ...check.missingIds, ...check.mailboxMismatchIds];
  return `${DRIFT_MESSAGES[check.driftReason ?? ""] ?? check.driftReason}${ids.length > 0 ? `(${ids.join(", ")})` : ""}`;
}

/** スタッフの集合が登録時から変わっていないこと(停止・照合の前に確かめる)。変わっていれば止める。 */
async function assertNoDrift(sql: Sql, salonId: string): Promise<LegacyCheck> {
  const check = await legacyCheck(sql, salonId);
  if (check.driftReason) {
    throw new OpsError(`旧側のスタッフの集合を確認できません: ${describeDrift(check)}。確認できるまで進めません。`);
  }
  return check;
}

async function loadMapping(sql: Sql, salonId: string): Promise<LegacyMapping | null> {
  const [row] = await sql<{ salon_id: string; legacy_mailbox: string; expected_staff_count: number }[]>`
    select salon_id, legacy_mailbox, expected_staff_count from public.legacy_salon_mappings where salon_id = ${salonId}`;
  return row ? { salonId: row.salon_id, mailbox: row.legacy_mailbox, expectedStaffCount: row.expected_staff_count } : null;
}

interface DiscoveredStaff {
  id: string;
  name: string | null;
  status: string;
  hasLine: boolean;
}

/** 予約受信用 Gmail で、旧側のスタッフ行を見つける(読み取りのみ)。 */
async function discoverLegacyStaff(sql: Sql, schema: string, mailbox: string): Promise<DiscoveredStaff[]> {
  return sql<DiscoveredStaff[]>`
    select m.salon_id::text as id, s.name, m.status, (l.salon_id is not null and l.destination_id is not null) as "hasLine"
      from ${sql(schema)}.mail_connections m
      left join ${sql(schema)}.salons s on s.id = m.salon_id
      left join ${sql(schema)}.line_connections l on l.salon_id = m.salon_id
     where public.legacy_mailbox_canonical(m.email_address) = ${mailbox}
     order by m.salon_id`;
}

async function loadStaffFacts(sql: Sql, schema: string, targetSalonId: string, ids: string[], mailbox: string): Promise<LegacyStaffFacts> {
  const validIds = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const existing = validIds.length
    ? await sql<{ id: string }[]>`select id::text from ${sql(schema)}.salons where id::text = any(${validIds})`
    : [];
  const mails = validIds.length
    ? await sql<{ id: string; mailbox: string }[]>`
        select salon_id::text as id, public.legacy_mailbox_canonical(email_address) as mailbox
          from ${sql(schema)}.mail_connections where salon_id::text = any(${validIds})`
    : [];
  const discovered = await discoverLegacyStaff(sql, schema, mailbox);
  const allIds = [...new Set([...validIds, ...discovered.map((d) => d.id)])];
  const elsewhere = allIds.length
    ? await sql<{ id: string; salon_id: string }[]>`
        select legacy_salon_id as id, salon_id::text from public.legacy_cutover_snapshots
         where legacy_salon_id = any(${allIds}) and salon_id <> ${targetSalonId}
        union
        select coalesce(migrated_from_hmail_salon_id, id::text) as id, salon_id::text from public.line_connections
         where (id::text = any(${allIds}) or migrated_from_hmail_salon_id = any(${allIds})) and salon_id <> ${targetSalonId}`
    : [];
  const here = await legacyStaffIds(sql, targetSalonId);
  return {
    existingIds: new Set(existing.map((r) => r.id)),
    mailboxById: new Map(mails.map((m) => [m.id, m.mailbox])),
    discoveredIds: discovered.map((d) => d.id),
    registeredElsewhere: new Map(elsewhere.map((r) => [r.id, r.salon_id])),
    registeredHere: here,
  };
}

/**
 * 対応表への登録(運営が、お客様・契約と旧側の予約受信用 Gmail・スタッフの人数を確認したあとに実行)。
 * 新側の店舗の所有者を Gmail アドレスから推定しない。確認のために、移行先の店舗と、その Gmail で見つかる
 * 旧側のスタッフ行を表示する。見つかった人数が確認した人数と違えば登録しない。
 */
export async function registerMapping(
  sql: Sql,
  options: { salonId: string; mailbox: string; expectedStaffCount: number; sourceSchema: string; note: string | null; apply: boolean; by: string; log: Log }
): Promise<"registered" | "already_registered" | "dry_run"> {
  const schema = assertSchema(options.sourceSchema);
  const { log } = options;
  const mailbox = canonicalMailbox(options.mailbox);
  if (!/^[^@\s]+@[^@\s]+$/.test(mailbox)) throw new OpsError("予約受信用 Gmail のアドレスが正しくありません。");
  if (!Number.isInteger(options.expectedStaffCount) || options.expectedStaffCount < 1) throw new OpsError("--expected-staff は1以上の整数です。");
  const [target] = await sql<{ id: string; name: string; plan: string; created_at: Date }[]>`
    select id, name, plan, created_at from public.salons where id = ${options.salonId}`;
  if (!target) throw new OpsError("移行先の店舗がありません。");
  log(`移行先(新側): salons.id=${target.id} 店舗名=${target.name} plan=${target.plan} 作成=${target.created_at.toISOString()}`);
  log(`旧側の予約受信用 Gmail(比較用の形): ${mailbox}`);
  const discovered = await discoverLegacyStaff(sql, schema, mailbox);
  for (const d of discovered) log(`  旧側のスタッフ ${d.id}: 名前=${d.name ?? "—"} 状態=${d.status} LINE=${d.hasLine ? "あり" : "なし"}`);
  log(`  見つかった旧側のスタッフ: ${discovered.length}人 / 確認した人数: ${options.expectedStaffCount}人`);

  const [byMailbox] = await sql<{ salon_id: string }[]>`
    select salon_id::text from public.legacy_salon_mappings where legacy_source = 'hmail' and legacy_mailbox = ${mailbox}`;
  if (byMailbox && byMailbox.salon_id !== options.salonId) throw new OpsError(`この予約受信用 Gmail は別の店舗(${byMailbox.salon_id})に対応付け済みです。`);
  const existing = await loadMapping(sql, options.salonId);
  if (existing) {
    if (existing.mailbox === mailbox && existing.expectedStaffCount === options.expectedStaffCount) {
      log("同じ内容で登録済みです。");
      return "already_registered";
    }
    throw new OpsError("この店舗は別の内容で対応表に登録済みです(変更は登録を確認し直してから手で行ってください)。");
  }
  if (discovered.length !== options.expectedStaffCount) {
    throw new OpsError("見つかった旧側のスタッフの人数が、確認した人数と一致しません。登録しません。");
  }
  if (!options.apply) {
    log("確認だけです。内容が正しければ --apply で対応表に登録します。");
    return "dry_run";
  }
  await sql`
    insert into public.legacy_salon_mappings (salon_id, legacy_source, legacy_mailbox, expected_staff_count, confirmed_by, note)
    values (${options.salonId}, 'hmail', ${mailbox}, ${options.expectedStaffCount}, ${options.by}, ${options.note})`;
  log("対応表に登録しました。");
  return "registered";
}

// ------------------------------------------------------------------
// 静的データの移行(スタッフの送信先・個人の設定)+ 旧サービス利用店舗としての登録
// ------------------------------------------------------------------

export async function staticMigrate(
  sql: Sql,
  options: { targetSalonId: string; hmailSalonIds: string[]; sourceSchema: string; apply: boolean; by: string; log: Log }
): Promise<void> {
  const schema = assertSchema(options.sourceSchema);
  const { log } = options;
  const [target] = await sql<{ id: string; name: string; plan: string }[]>`
    select id, name, plan from public.salons where id = ${options.targetSalonId}`;
  if (!target) throw new OpsError("移行先の店舗がありません。");
  log(`移行先: salons.id=${target.id} plan=${target.plan}`);
  if (target.plan !== "salonpack") log("警告: 移行先の契約に予約通知が含まれていません(開始はできません)。");

  // 書き込みの前に、指定されたスタッフの集合が対応表の予約受信用 Gmail のスタッフと完全に一致することを確かめる。
  const checkStaffSet = async (db: Sql) => {
    const mapping = await loadMapping(db, options.targetSalonId);
    const facts = mapping ? await loadStaffFacts(db, schema, options.targetSalonId, options.hmailSalonIds, mapping.mailbox) : null;
    const problems = validateLegacyStaffSet({
      targetSalonId: options.targetSalonId,
      requestedIds: options.hmailSalonIds,
      mapping,
      facts: facts ?? { existingIds: new Set(), mailboxById: new Map(), discoveredIds: [], registeredElsewhere: new Map(), registeredHere: [] },
    });
    if (problems.length > 0) {
      for (const p of problems) log(`  ✗ ${describeStaffSetProblem(p)}`);
      throw new OpsError("スタッフの指定が対応表と一致しないため、何も書き込んでいません。");
    }
    log(`  ✓ スタッフ ${options.hmailSalonIds.length} 人 = 予約受信用 Gmail(${mapping!.mailbox})の旧側のスタッフ全員(対応表の人数と一致)`);
  };
  await checkStaffSet(sql);

  const staff: HmailStaffSettings[] = [];
  const lines = new Map<string, { destination_id: string; status: string; linked_at: Date | null }>();
  const statuses: Array<{ legacy_salon_id: string; original_status: string | null }> = [];
  for (const id of options.hmailSalonIds) {
    const [line] = await sql<{ destination_id: string; status: string; linked_at: Date | null }[]>`
      select destination_id, status, linked_at from ${sql(schema)}.line_connections where salon_id::text = ${id}`;
    const [settings] = await sql<{ master_enabled: boolean; new_reservation_enabled: boolean; cancellation_enabled: boolean }[]>`
      select master_enabled, new_reservation_enabled, cancellation_enabled from ${sql(schema)}.notification_settings where salon_id::text = ${id}`;
    const [mail] = await sql<{ status: string }[]>`select status from ${sql(schema)}.mail_connections where salon_id::text = ${id}`;
    statuses.push({ legacy_salon_id: id, original_status: mail?.status ?? null });
    if (!line) {
      log(`  スタッフ ${id}: LINE の送信先がありません(送信先は移行しません)`);
      continue;
    }
    lines.set(id, line);
    staff.push({
      hmailSalonId: id,
      masterEnabled: settings?.master_enabled ?? null,
      newReservationEnabled: settings?.new_reservation_enabled ?? null,
      cancellationEnabled: settings?.cancellation_enabled ?? null,
    });
  }
  const folded = foldAllStaffSettings(staff);
  for (const f of folded) {
    log(
      `  スタッフ ${f.hmailSalonId}: 旧側の接続=${statuses.find((s) => s.legacy_salon_id === f.hmailSalonId)?.original_status ?? "なし"} ` +
        `新規予約=${f.newReservationEnabled} キャンセル=${f.cancellationEnabled}${f.missingSettings ? "(設定が無いため OFF)" : ""}`
    );
  }
  if (!options.apply) {
    log("確認だけです(書き込んでいません)。");
    return;
  }

  await sql.begin(async (tx) => {
    // 確認と書き込みの間に旧側・対応表が変わっていないか、同じトランザクションの中でもう一度確かめる。
    await checkStaffSet(tx as unknown as Sql);
    for (const f of folded) {
      const line = lines.get(f.hmailSalonId)!;
      const written = await tx`
        insert into public.line_connections
          (id, salon_id, destination_id, status, new_reservation_enabled, cancellation_enabled, linked_at, migrated_from_hmail_salon_id, added_via, updated_at)
        values (${f.hmailSalonId}, ${options.targetSalonId}, ${line.destination_id}, ${line.status},
                ${f.newReservationEnabled}, ${f.cancellationEnabled}, ${line.linked_at}, ${f.hmailSalonId}, 'hmail_migration', now())
        on conflict (id) do update set
          destination_id = excluded.destination_id, status = excluded.status,
          new_reservation_enabled = excluded.new_reservation_enabled, cancellation_enabled = excluded.cancellation_enabled,
          linked_at = excluded.linked_at, updated_at = now()
         where public.line_connections.salon_id = excluded.salon_id
        returning id`;
      if (written.length !== 1) throw new OpsError(`スタッフ ${f.hmailSalonId} の送信先は別の店舗のものです(書き込みを取り消しました)。`);
    }
    await tx`insert into public.notification_settings (salon_id, master_enabled) values (${options.targetSalonId}, true) on conflict (salon_id) do nothing`;
    await tx`
      insert into public.salon_feature_selections (salon_id, feature_key, selected, updated_at)
      values (${options.targetSalonId}, 'reservation_notifications', true, now())
      on conflict (salon_id, feature_key) do nothing`;
    const [{ reservation_ops_mark_legacy: result }] = await tx<{ reservation_ops_mark_legacy: string }[]>`
      select public.reservation_ops_mark_legacy(${options.targetSalonId}::uuid, ${options.by}, ${schema}, ${tx.json(statuses)}::jsonb)`;
    if (result !== "marked") throw new OpsError(`旧サービス利用店舗として登録できません: ${result}`);
  });
  log("移行しました(切り替え待ち)。お客様にGoogleへの再接続を依頼できます。");
}

// ------------------------------------------------------------------
// 一覧(運営がお客様の再接続を確認する)
// ------------------------------------------------------------------

export interface OperationsListRow {
  salonId: string;
  salonName: string;
  state: string;
  legacy: boolean;
  googleConnection: string;
  firstConnectedAt: Date | null;
  lastReconnectedAt: Date | null;
  accountEmail: string | null;
  grantedScopes: string[];
  legacyStopConfirmedAt: Date | null;
  latestReconciliation: { ranAt: Date; unresolved: number; accepted: boolean; counts: Record<string, number> } | null;
  activatedAt: Date | null;
  /** 対応表の旧側の予約受信用 Gmail(旧サービス利用店舗のみ)。 */
  legacyMailbox: string | null;
  /** 接続した Google アカウントが、対応表の予約受信用 Gmail と同じか(未接続・対応表なしは null)。 */
  gmailMatchesLegacyMailbox: boolean | null;
  /** 旧側の確認(状態・スタッフの集合。reservation_ops_legacy_check)。 */
  legacyCheck: { state: string; reason: string | null } | null;
}

export async function listOperations(sql: Sql, options: { awaitingOnly: boolean }): Promise<OperationsListRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select o.salon_id, s.name, o.state, o.legacy_source, o.legacy_stop_confirmed_at, o.activated_at,
           b.first_connected_at, b.last_reconnected_at, coalesce(b.account_email, a.email) as account_email,
           b.scope_missing_since, a.granted_scopes, a.auth_state,
           m.legacy_mailbox,
           r.ran_at, r.unresolved_count, r.accepted_at, r.counts,
           c.state as legacy_state, c.reason as legacy_reason
      from public.reservation_notification_operations o
      join public.salons s on s.id = o.salon_id
      left join public.salon_google_bindings b on b.salon_id = o.salon_id and b.feature = 'gmail'
      left join public.google_accounts a on a.id = b.google_account_id
      left join public.legacy_salon_mappings m on m.salon_id = o.salon_id
      left join lateral (
        select * from public.legacy_reconciliation_runs r where r.salon_id = o.salon_id order by r.ran_at desc limit 1
      ) r on true
      left join lateral (
        select x.state, x.reason from public.reservation_ops_legacy_check(o.salon_id) x where o.legacy_source is not null
      ) c on true
     where (${!options.awaitingOnly} or o.state = 'awaiting_cutover')
     order by s.name`;
  return rows.map((r) => {
    const scopes = (r.granted_scopes as string[] | null) ?? [];
    const hasGmail = scopes.includes("https://www.googleapis.com/auth/gmail.readonly") && !r.scope_missing_since;
    const googleConnection = !r.first_connected_at
      ? "未接続"
      : r.auth_state !== "active"
        ? "再接続が必要"
        : !hasGmail
          ? "Gmailの権限が不足"
          : "再接続済み";
    const accountEmail = (r.account_email as string | null) ?? null;
    const legacyMailbox = (r.legacy_mailbox as string | null) ?? null;
    return {
      salonId: r.salon_id as string,
      salonName: r.name as string,
      state: r.state as string,
      legacy: Boolean(r.legacy_source),
      googleConnection,
      firstConnectedAt: (r.first_connected_at as Date | null) ?? null,
      lastReconnectedAt: (r.last_reconnected_at as Date | null) ?? null,
      accountEmail,
      grantedScopes: scopes,
      legacyStopConfirmedAt: (r.legacy_stop_confirmed_at as Date | null) ?? null,
      latestReconciliation: r.ran_at
        ? {
            ranAt: r.ran_at as Date,
            unresolved: r.unresolved_count as number,
            accepted: Boolean(r.accepted_at),
            counts: (r.counts as Record<string, number>) ?? {},
          }
        : null,
      activatedAt: (r.activated_at as Date | null) ?? null,
      legacyMailbox,
      gmailMatchesLegacyMailbox: accountEmail && legacyMailbox ? canonicalMailbox(accountEmail) === legacyMailbox : null,
      legacyCheck: r.legacy_state ? { state: r.legacy_state as string, reason: (r.legacy_reason as string | null) ?? null } : null,
    };
  });
}

export async function connectionHistory(sql: Sql, salonId: string) {
  return sql<Array<{ occurred_at: Date; feature: string | null; event: string; account_email: string | null }>>`
    select occurred_at, feature, event, account_email from public.salon_google_connection_events
     where salon_id = ${salonId} order by occurred_at`;
}

export async function deliveryStatus(sql: Sql, salonId: string) {
  const counts = await sql<Array<{ status: string; origin: string; count: number }>>`
    select status, origin, count(*)::int as count from public.notification_deliveries where salon_id = ${salonId} group by status, origin order by status`;
  const review = await sql<Array<{ id: string; provider_message_id: string; line_connection_id: string; skip_reason: string | null }>>`
    select id, provider_message_id, line_connection_id, skip_reason from public.notification_deliveries
     where salon_id = ${salonId} and status = 'needs_review' order by created_at`;
  const unknownExpired = await sql<Array<{ id: string; first_attempt_at: Date }>>`
    select id, first_attempt_at from public.notification_deliveries
     where salon_id = ${salonId} and status = 'unknown' and first_attempt_at <= now() - interval '23 hours'`;
  const inflight = await sql<Array<{ id: string; send_started_at: Date }>>`
    select id, send_started_at from public.notification_deliveries
     where salon_id = ${salonId} and status = 'claimed' and send_started_at is not null`;
  const [{ count: unprocessable }] = await sql<Array<{ count: number }>>`
    select count(*)::int as count from public.processed_emails where salon_id = ${salonId} and event_type = 'unprocessable'`;
  return { counts, review, unknownExpired, inflight, unprocessable };
}

// ------------------------------------------------------------------
// ② 旧側の停止(cron を一時停止した状態で、スタッフ全員分の行を止める)
// ------------------------------------------------------------------

async function checkLegacyRuns(
  sql: Sql,
  schema: string,
  pausedAt: Date,
  attestRunEnded: string[]
): Promise<{ inflight: string[]; unattested: string[]; startedAfterPause: number }> {
  const inflightRows = await sql<{ id: string }[]>`
    select id::text from ${sql(schema)}.cron_runs where started_at < ${pausedAt} and finished_at is null`;
  const inflight = inflightRows.map((r) => r.id);
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(schema)}.cron_runs where started_at >= ${pausedAt}`;
  return { inflight, unattested: inflight.filter((id) => !attestRunEnded.includes(id)), startedAfterPause: count };
}

export async function stopLegacy(
  sql: Sql,
  options: { salonId: string; cronPausedAt: Date; attestRunEnded: string[]; apply: boolean; approveHmailWrite: boolean; log: Log }
): Promise<"stopped" | "dry_run"> {
  const { log } = options;
  const ops = await loadOps(sql, options.salonId);
  if (!ops.legacy_source || ops.state !== "awaiting_cutover") throw new OpsError("切り替え待ちの旧サービス利用店舗ではありません。");
  const schema = assertSchema(ops.legacy_schema);
  const staffIds = await legacyStaffIds(sql, options.salonId);
  if (staffIds.length === 0) throw new OpsError("旧側のスタッフの控えがありません。");
  // 登録のあとに同じ予約受信用 Gmail のスタッフ行が増えた・減った等なら、止める対象が確定しないので進めない。
  await assertNoDrift(sql, options.salonId);

  const runs = await checkLegacyRuns(sql, schema, options.cronPausedAt, options.attestRunEnded);
  if (runs.startedAfterPause > 0) throw new OpsError(`cron の一時停止のあとに旧側の処理が ${runs.startedAfterPause} 件始まっています(まだ動いています)。`);
  if (runs.unattested.length > 0) {
    throw new OpsError(
      `停止前に始まって終了の記録が無い旧側の処理があります: ${runs.unattested.join(", ")}。` +
        "旧側の関数のログで終了を確認し、--attest-run-ended で指定してください(時間の経過だけでは確認済みにしません)。"
    );
  }
  const current = await sql<{ salon_id: string; status: string }[]>`
    select salon_id::text, status from ${sql(schema)}.mail_connections where salon_id::text = any(${staffIds})`;
  if (current.length !== staffIds.length) throw new OpsError("旧側のスタッフの行の数が控えと一致しません(確認できないため止めます)。");
  for (const row of current) log(`  スタッフ ${row.salon_id}: 現在の状態=${row.status}`);
  if (!options.apply) {
    log("確認だけです。--apply --approve-hmail-write で、スタッフ全員分の行を止めます(削除はしません)。");
    return "dry_run";
  }
  if (!options.approveHmailWrite) throw new OpsError("旧側(hmail)への書き込みには --approve-hmail-write が必要です。");
  await sql.begin(async (tx) => {
    for (const row of current) {
      if (row.status === LEGACY_STOPPED_STATUS) continue;
      await tx`update public.legacy_cutover_snapshots set original_status = ${row.status}
                where salon_id = ${options.salonId} and legacy_salon_id = ${row.salon_id} and stop_applied_at is null`;
    }
    // 対象は登録したスタッフの行だけ(他の店舗(例: 旧側で継続する店舗)の行には触れない)。
    await tx`update ${tx(schema)}.mail_connections set status = ${LEGACY_STOPPED_STATUS}
              where salon_id::text = any(${staffIds}) and status <> ${LEGACY_STOPPED_STATUS}`;
    await tx`update public.legacy_cutover_snapshots set stop_applied_at = now()
              where salon_id = ${options.salonId} and stop_applied_at is null`;
  });
  log(`スタッフ ${staffIds.length} 人分の旧側の処理を止めました。cron-job.org のジョブを再開してから confirm-cutover を実行してください。`);
  return "stopped";
}

export async function confirmCutover(
  sql: Sql,
  options: {
    salonId: string;
    cronPausedAt: Date;
    cronResumedAt: Date;
    attestRunEnded: string[];
    apply: boolean;
    by: string;
    log: Log;
  }
): Promise<"confirmed" | "dry_run"> {
  const { log } = options;
  const ops = await loadOps(sql, options.salonId);
  if (!ops.legacy_source) throw new OpsError("旧サービス利用店舗ではありません。");
  const schema = assertSchema(ops.legacy_schema);
  const staffIds = await legacyStaffIds(sql, options.salonId);
  const [stop] = await sql<{ stop_applied_at: Date | null }[]>`
    select min(stop_applied_at) as stop_applied_at from public.legacy_cutover_snapshots where salon_id = ${options.salonId}`;
  if (!stop?.stop_applied_at) throw new OpsError("旧側の停止(stop-legacy)がまだです。");

  const problems: string[] = [];
  const [{ count: duringPause }] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(schema)}.cron_runs where started_at >= ${options.cronPausedAt} and started_at < ${options.cronResumedAt}`;
  if (duringPause > 0) problems.push(`一時停止の間に旧側の処理が ${duringPause} 件始まっています(新しい処理を止められていません)`);
  const runs = await checkLegacyRuns(sql, schema, options.cronPausedAt, options.attestRunEnded);
  if (runs.unattested.length > 0) problems.push(`停止前に始まった処理の終了を確認できません: ${runs.unattested.join(", ")}`);
  const [after] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(schema)}.cron_runs
     where started_at >= ${options.cronResumedAt} and started_at > ${stop.stop_applied_at} and finished_at is not null`;
  if (after.count === 0) problems.push("再開後に最後まで終わった旧側の処理がまだありません(再開後の1回分を待ってください)");
  const check = await legacyCheck(sql, options.salonId);
  if (check.driftReason) problems.push(`旧側のスタッフの集合を確認できません: ${describeDrift(check)}`);
  else if (check.state !== "stopped") {
    problems.push(`旧側の監視の結果が「止まっている」ではありません: ${check.state}${check.activeIds.length ? `(処理対象のまま: ${check.activeIds.join(", ")})` : ""}`);
  }
  const [{ count: newProcessed }] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(schema)}.processed_emails
     where salon_id::text = any(${staffIds}) and processed_at > ${stop.stop_applied_at}`;
  if (newProcessed > 0) problems.push(`停止のあとに旧側でメールが ${newProcessed} 件処理されています`);

  for (const p of problems) log(`  ✗ ${p}`);
  if (problems.length > 0) throw new OpsError("旧側の停止を確認できませんでした。");
  log("  ✓ 新しい処理が始まっていない・実行中の処理が終わった・再開後の処理でも止まったまま・停止後の処理なし");
  if (!options.apply) {
    log("確認だけです。--apply で停止確認を記録します。");
    return "dry_run";
  }
  const [{ reservation_ops_confirm_legacy_stop: result }] = await sql<{ reservation_ops_confirm_legacy_stop: string }[]>`
    select public.reservation_ops_confirm_legacy_stop(${options.salonId}::uuid, ${options.by})`;
  if (result !== "confirmed") throw new OpsError(`停止確認を記録できません: ${result}`);
  log("旧側の停止確認を記録しました。次に reconcile を実行してください。");
  return "confirmed";
}

// ------------------------------------------------------------------
// ③ 送信状態の照合(メール×スタッフ)
// ------------------------------------------------------------------

export async function reconcile(
  sql: Sql,
  options: { salonId: string; windowFrom: Date; apply: boolean; by: string; log: Log }
): Promise<{ runId: string | null; counts: Record<string, number>; unresolved: number }> {
  const { log } = options;
  const ops = await loadOps(sql, options.salonId);
  if (!ops.legacy_source) throw new OpsError("旧サービス利用店舗ではありません。");
  const schema = assertSchema(ops.legacy_schema);
  const staffIds = await legacyStaffIds(sql, options.salonId);
  // スタッフの集合が変わっていたら、照合の対象(誰に送ったか)が確定しないので照合しない。
  await assertNoDrift(sql, options.salonId);

  const processed = await sql<Array<{ salon_id: string; provider_message_id: string; event_type: string; processed_at: Date }>>`
    select salon_id::text, provider_message_id, event_type, processed_at from ${sql(schema)}.processed_emails
     where salon_id::text = any(${staffIds}) and processed_at >= ${options.windowFrom}`;
  const messageIds = [...new Set(processed.map((p) => p.provider_message_id))];
  const history = messageIds.length
    ? await sql<Array<{ salon_id: string; provider_message_id: string; status: string; error_message: string | null; line_text: string | null; event_type: string }>>`
        select salon_id::text, provider_message_id, status, error_message, line_text, event_type from ${sql(schema)}.notification_history
         where salon_id::text = any(${staffIds}) and provider_message_id = any(${messageIds})`
    : [];

  const results = messageIds.map((messageId) => {
    const states: HmailStaffEmailState[] = staffIds.map((staffId) => {
      const p = processed.find((r) => r.salon_id === staffId && r.provider_message_id === messageId);
      return {
        staffId,
        providerMessageId: messageId,
        processed: p ? { eventType: p.event_type, processedAt: p.processed_at.toISOString() } : null,
        history: history
          .filter((h) => h.salon_id === staffId && h.provider_message_id === messageId)
          .map((h) => ({ status: h.status, errorMessage: h.error_message, lineText: h.line_text, eventType: h.event_type })),
      };
    });
    return reconcileEmail(messageId, states, staffIds);
  });
  const counts = summarize(results);
  log(`照合: ${JSON.stringify(counts)}`);
  for (const r of results) {
    for (const [staffId, o] of r.outcomes) {
      if (o.kind === "needs_review") log(`  確認が必要: メール ${r.providerMessageId} × スタッフ ${staffId}(${o.reason})`);
    }
  }
  if (!options.apply) {
    log("確認だけです(書き込んでいません)。");
    return { runId: null, counts, unresolved: counts.needs_review ?? 0 };
  }

  let runId: string | null = null;
  let unresolved = 0;
  await sql.begin(async (tx) => {
    for (const r of results) {
      if (r.notHotpepper) {
        await tx`insert into public.processed_emails (salon_id, provider_message_id, event_type, processed_at)
                 values (${options.salonId}, ${r.providerMessageId}, 'not_hotpepper', ${r.earliestProcessedAt})
                 on conflict (salon_id, provider_message_id) do nothing`;
        continue;
      }
      for (const [staffId, o] of r.outcomes) {
        if (o.kind !== "sent" && o.kind !== "skipped" && o.kind !== "needs_review") continue;
        const status = o.kind;
        const lineText = o.kind === "sent" ? (o.lineText ?? "") : "";
        const reason = o.kind === "sent" ? null : o.reason;
        // 新側が出した結果(origin='salonpack')は上書きしない(切り替え後の再実行で巻き戻さない)。
        await tx`
          insert into public.notification_deliveries as d
            (salon_id, provider_message_id, line_connection_id, destination_id, event_type, line_text, status, origin, skip_reason)
          select ${options.salonId}, ${r.providerMessageId}, lc.id, lc.destination_id, ${o.eventType}, ${lineText}, ${status}, 'hmail', ${reason}
            from public.line_connections lc where lc.id = ${staffId} and lc.salon_id = ${options.salonId}
          on conflict (provider_message_id, line_connection_id) where manual_resend_of is null
          do update set status = excluded.status, skip_reason = excluded.skip_reason, updated_at = now()
           where d.origin = 'hmail' and d.resolved_at is null`;
      }
      if (r.fullyHandled) {
        await tx`insert into public.processed_emails (salon_id, provider_message_id, event_type, processed_at)
                 values (${options.salonId}, ${r.providerMessageId}, ${r.eventType}, ${r.earliestProcessedAt})
                 on conflict (salon_id, provider_message_id) do nothing`;
      } else {
        // 一部のスタッフだけ処理済み: 新側で分類し直し、未送信のスタッフにだけ配信行を作る(検索の範囲に依存しない)。
        await tx`insert into public.processed_emails (salon_id, provider_message_id, event_type, processed_at, handover, classify_attempts)
                 values (${options.salonId}, ${r.providerMessageId}, 'pending', now() - interval '1 hour', true, 0)
                 on conflict (salon_id, provider_message_id) do nothing`;
      }
    }
    const [{ count }] = await tx<{ count: number }[]>`
      select count(*)::int as count from public.notification_deliveries where salon_id = ${options.salonId} and status = 'needs_review'`;
    unresolved = count;
    const earliestUnhandled = results.filter((r) => !r.fullyHandled).map((r) => r.earliestProcessedAt).filter(Boolean).sort()[0] ?? null;
    const [run] = await tx<{ id: string }[]>`
      insert into public.legacy_reconciliation_runs (salon_id, source_schema, window_from, ran_by, counts, unresolved_count, earliest_unhandled_mail_at)
      values (${options.salonId}, ${schema}, ${options.windowFrom}, ${options.by}, ${tx.json(counts)}, ${count}, ${earliestUnhandled})
      returning id`;
    runId = run.id;
  });
  log(`照合結果を記録しました(run ${runId}、未解決 ${unresolved} 件)。`);
  return { runId, counts, unresolved };
}

export async function acceptReconciliation(sql: Sql, options: { runId: string; by: string; log: Log }): Promise<void> {
  const [{ reservation_ops_accept_reconciliation: result }] = await sql<{ reservation_ops_accept_reconciliation: string }[]>`
    select public.reservation_ops_accept_reconciliation(${options.runId}::uuid, ${options.by})`;
  if (result !== "accepted") throw new OpsError(`照合結果を受け入れられません: ${result}`);
  options.log("照合結果を受け入れました。");
}

// ------------------------------------------------------------------
// ④ 開始 / 停止 / 個別の解決
// ------------------------------------------------------------------

export async function activate(
  sql: Sql,
  options: { salonId: string; mailFetchSince: Date | null; reason: string | null; apply: boolean; by: string; log: Log }
): Promise<"activated" | "dry_run"> {
  const ops = await loadOps(sql, options.salonId);
  let fetchSince = options.mailFetchSince;
  let reason = options.reason;
  const [run] = ops.legacy_source && ops.accepted_reconciliation_id
    ? await sql<{ window_from: Date | null; earliest_unhandled_mail_at: Date | null }[]>`
        select window_from, earliest_unhandled_mail_at from public.legacy_reconciliation_runs where id = ${ops.accepted_reconciliation_id}`
    : [];
  // 受け入れた照合が無い等は、DB(reservation_ops_guard)が理由を付けて拒否する。
  if (ops.legacy_source && run?.window_from) {
    if (!fetchSince) {
      // 照合した範囲の始めから読む(お客様が再接続した日時ではない。再接続より前に届いて旧側でも処理されて
      // いないメールも取り込む。旧側で処理済みのものは照合で記録済みのため重複しない)。
      fetchSince = run.window_from;
      reason = "reconciliation_window";
    }
    if (fetchSince < run.window_from) throw new OpsError("照合した範囲より前から読むことはできません(旧側で処理済みかを確かめていないため)。");
    if (run.earliest_unhandled_mail_at && fetchSince > run.earliest_unhandled_mail_at) {
      options.log(`  注意: 旧側で一部のスタッフに未送信のメール(${run.earliest_unhandled_mail_at.toISOString()})より後から読みます。`);
    }
    const [gmail] = await sql<{ email: string | null }[]>`
      select coalesce(b.account_email, a.email) as email from public.salon_google_bindings b
        join public.google_accounts a on a.id = b.google_account_id where b.salon_id = ${options.salonId} and b.feature = 'gmail'`;
    const mapping = await loadMapping(sql, options.salonId);
    const matches = Boolean(gmail?.email && mapping && canonicalMailbox(gmail.email) === mapping.mailbox);
    options.log(`  予約メールの接続アカウント: ${gmail?.email ?? "未接続"}(対応表の受信用 Gmail ${mapping?.mailbox ?? "—"} と${matches ? "一致" : "不一致"})`);
  }
  if (!fetchSince && !ops.mail_fetch_since) throw new OpsError("メール取得開始日時(--mail-fetch-since)と理由を指定してください。");
  options.log(`開始: メール取得開始=${(fetchSince ?? ops.mail_fetch_since)!.toISOString()}(${reason ?? "既存の値"})`);
  if (!options.apply) return "dry_run";
  try {
    const [{ reservation_ops_activate: result }] = await sql<{ reservation_ops_activate: string }[]>`
      select public.reservation_ops_activate(${options.salonId}::uuid, ${options.by}, ${fetchSince}, ${reason})`;
    if (result !== "activated") throw new OpsError(`開始できません: ${result}`);
  } catch (error) {
    if (error instanceof OpsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new OpsError(`開始できません(DB が拒否しました): ${message.match(/reservation_ops:[a-z_:]+/)?.[0] ?? "unknown"}`);
  }
  options.log("予約通知を開始しました。");
  return "activated";
}

export async function pause(
  sql: Sql,
  options: { salonId: string; reason: string; apply: boolean; by: string; log: Log }
): Promise<number> {
  if (!options.apply) {
    options.log("確認だけです。--apply で停止します。");
    return 0;
  }
  const [{ reservation_ops_pause: inflight }] = await sql<{ reservation_ops_pause: number }[]>`
    select public.reservation_ops_pause(${options.salonId}::uuid, ${options.by}, ${options.reason}, 'operator_pause')`;
  if (inflight > 0) {
    options.log(
      `停止しました。ただし送信を始めて結果がまだ出ていない配信が ${inflight} 件あります(結果待ち・不明の可能性)。` +
        "処理権が切れても送信が取り消されたとは限らないため、status で結果が出るまで確認してください。"
    );
  } else {
    options.log("停止しました。送信中の配信はありません。");
  }
  return inflight;
}

export type ResolveMode = "sent" | "skipped" | "send_now" | "retry_same_key" | "manual_resend";

export async function resolveDelivery(
  sql: Sql,
  options: { deliveryId: string; mode: ResolveMode; reason: string; acceptDuplicateRisk: boolean; apply: boolean; by: string; log: Log }
): Promise<void> {
  const [d] = await sql<Array<{ id: string; status: string; first_attempt_at: Date | null; origin: string }>>`
    select id, status, first_attempt_at, origin from public.notification_deliveries where id = ${options.deliveryId}`;
  if (!d) throw new OpsError("配信が見つかりません。");
  if (!["needs_review", "unknown"].includes(d.status)) throw new OpsError(`この状態の配信は解決の対象ではありません: ${d.status}`);
  const withinWindow = d.first_attempt_at && d.first_attempt_at.getTime() > Date.now() - 23 * 60 * 60 * 1000;
  if (options.mode === "send_now" && d.first_attempt_at) throw new OpsError("送信を試みたことがある配信は send_now にできません(retry_same_key か manual_resend)。");
  if (options.mode === "retry_same_key" && !withinWindow) throw new OpsError("retry key の有効期間を過ぎています。同じキーでの再試行はできません。");
  if (options.mode === "manual_resend" && !options.acceptDuplicateRisk) {
    throw new OpsError("新しい retry key での手動再送は、元の送信が受け付け済みなら重複します。--accept-duplicate-risk を付けてください。");
  }
  if ((options.mode === "send_now" || options.mode === "manual_resend") && d.origin !== "salonpack" && d.status !== "needs_review") {
    throw new OpsError("旧側の記録は確認待ちのものだけ扱えます。");
  }
  options.log(`解決: ${options.deliveryId} → ${options.mode}(${options.reason})`);
  if (!options.apply) return;

  await sql.begin(async (tx) => {
    switch (options.mode) {
      case "sent":
      case "skipped":
        await tx`update public.notification_deliveries
                    set status = ${options.mode}, skip_reason = coalesce(skip_reason, ${options.reason}),
                        resolved_by = ${options.by}, resolved_at = now(), updated_at = now()
                  where id = ${options.deliveryId}`;
        break;
      case "send_now":
        await tx`update public.notification_deliveries
                    set status = 'pending', origin = 'salonpack', operator_approved_at = now(),
                        resolved_by = ${options.by}, resolved_at = now(), updated_at = now()
                  where id = ${options.deliveryId}`;
        break;
      case "retry_same_key":
        await tx`update public.notification_deliveries
                    set status = 'unknown', next_attempt_at = now(), resolved_by = ${options.by}, resolved_at = now(), updated_at = now()
                  where id = ${options.deliveryId}`;
        break;
      case "manual_resend":
        await tx`
          insert into public.notification_deliveries
            (salon_id, provider_message_id, line_connection_id, destination_id, event_type, line_text, mail_received_at,
             status, origin, manual_resend_of, resend_approved_by, operator_approved_at)
          select salon_id, provider_message_id, line_connection_id, destination_id, event_type, line_text, mail_received_at,
                 'pending', 'salonpack', id, ${options.by}, now()
            from public.notification_deliveries where id = ${options.deliveryId}`;
        await tx`update public.notification_deliveries set resolved_by = ${options.by}, resolved_at = now(),
                        status = case when status = 'needs_review' then 'skipped' else status end,
                        skip_reason = coalesce(skip_reason, 'manual_resend_issued'), updated_at = now()
                  where id = ${options.deliveryId}`;
        break;
    }
  });
}

// ------------------------------------------------------------------
// 切り戻し
// ------------------------------------------------------------------

export async function rollback(
  sql: Sql,
  options: { salonId: string; mode: "A" | "B"; apply: boolean; approveHmailWrite: boolean; by: string; log: Log }
): Promise<{ held: string[] }> {
  const { log } = options;
  const ops = await loadOps(sql, options.salonId);
  if (!ops.legacy_source) throw new OpsError("旧サービス利用店舗ではありません。");
  const schema = assertSchema(ops.legacy_schema);
  const attempted = await sql<Array<{ provider_message_id: string; line_connection_id: string; status: string; origin: "salonpack" | "hmail"; first_attempt_at: Date | null; event_type: string }>>`
    select provider_message_id, line_connection_id::text, status, origin, first_attempt_at, event_type
      from public.notification_deliveries where salon_id = ${options.salonId} and origin = 'salonpack'`;
  const anyAttempt = attempted.some((d) => d.first_attempt_at || ["sent", "unknown", "claimed"].includes(d.status));

  if (options.mode === "A" && anyAttempt) {
    throw new OpsError("新側が送信を試みています。切り戻しAは使えません(B で、メール×スタッフごとに確認してください)。");
  }
  const plan =
    options.mode === "B"
      ? buildRollbackPlan(
          attempted.map((d) => ({
            providerMessageId: d.provider_message_id,
            lineConnectionId: d.line_connection_id,
            status: d.status,
            origin: d.origin,
            firstAttemptAt: d.first_attempt_at?.toISOString() ?? null,
            eventType: d.event_type,
          }))
        )
      : { markProcessed: [], holdStaff: [], leaveForLegacy: [] };
  const snapshots = await sql<Array<{ legacy_salon_id: string; original_status: string | null }>>`
    select legacy_salon_id, original_status from public.legacy_cutover_snapshots where salon_id = ${options.salonId}`;
  log(`旧側で処理済みにする組: ${plan.markProcessed.length} / 旧側が送る組: ${plan.leaveForLegacy.length} / 保留するスタッフ: ${plan.holdStaff.join(", ") || "なし"}`);
  for (const s of snapshots) {
    log(`  スタッフ ${s.legacy_salon_id}: ${plan.holdStaff.includes(s.legacy_salon_id) ? "保留(結果不明を解決するまで旧側を再開しない)" : `元の状態(${s.original_status ?? "不明"})へ戻す`}`);
  }
  if (!options.apply) return { held: plan.holdStaff };
  if (!options.approveHmailWrite) throw new OpsError("旧側(hmail)への書き込みには --approve-hmail-write が必要です。");

  await sql`select public.reservation_ops_pause(${options.salonId}::uuid, ${options.by}, 'rollback', 'operator_pause')`;
  await sql.begin(async (tx) => {
    for (const m of plan.markProcessed) {
      await tx`insert into ${tx(schema)}.processed_emails (salon_id, provider_message_id, event_type)
               values (${m.staffId}::uuid, ${m.providerMessageId}, ${m.eventType})
               on conflict (salon_id, provider_message_id) do nothing`;
    }
    for (const s of snapshots) {
      if (plan.holdStaff.includes(s.legacy_salon_id) || !s.original_status) continue;
      await tx`update ${tx(schema)}.mail_connections set status = ${s.original_status}
                where salon_id::text = ${s.legacy_salon_id} and status = ${LEGACY_STOPPED_STATUS}`;
      await tx`update public.legacy_cutover_snapshots set restored_at = now()
                where salon_id = ${options.salonId} and legacy_salon_id = ${s.legacy_salon_id}`;
    }
    // もう一度切り替えるときは、停止確認・照合からやり直す。
    await tx`update public.reservation_notification_operations
                set state = 'awaiting_cutover', legacy_stop_confirmed_at = null, accepted_reconciliation_id = null
              where salon_id = ${options.salonId}`;
  });
  log("切り戻しました(新側は停止、旧側はスタッフごとの元の状態へ)。");
  return { held: plan.holdStaff };
}
