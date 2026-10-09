// 旧サービス(hmail)から SalonPack への切り替えの通しのテスト。
// テスト用DBに、hmail の表の形だけを写した「hmail_fixture」スキーマを作って検証する
// (テスト用DBに hmail という名前のスキーマは作らない -- 接続先の確認で本番と区別しているため)。
// Google は擬似、Gmail・LINE はモック。旧側への書き込みは fixture のスキーマにだけ行う。
//
// 店舗の想定: 「Lavi に相当(予約受信用 Gmail 1つ・スタッフ3人)」を先に切り替え、「ayana に相当」は旧側で継続する。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { setupNotificationsTestEnv, openDirectConnections, closeConnections } from "./setupNotificationsEnv";
import { createTestSalon, notificationsTestAdminClient, type TestSalonFixture } from "./notificationsFixtures";
import { connectGoogle, createGoogleTestDeps, uniqueSub } from "./googleFixtures";
import { inbox, providersBySalon, reservationMail, type TestInbox, type TestMail } from "./mailboxFixtures";

const target = setupNotificationsTestEnv();
process.env.NEXT_PUBLIC_APP_MODE = "salonpack";
const admin = notificationsTestAdminClient();
const ops = await import("../notifications-ops/core");
const { pollMailForAllSalons } = await import("@/lib/notifications/jobs/pollMailForAllSalons");
const { customerStartReservationNotifications } = await import("@/lib/notifications/db/operations");

const FIXTURE = "hmail_fixture";
const LAVI_MAILBOX = "shop@example.test";
const AYANA_MAILBOX = "ayana.shop@gmail.com";
const log = () => {};
const BY = "operator:test";

let sql: postgres.Sql;
let conns: postgres.Sql[] = [];
const salons: TestSalonFixture[] = [];
const subs: string[] = [];

async function dbNow(offsetMs = 0): Promise<Date> {
  const [{ now }] = await sql<{ now: Date }[]>`select now() as now`;
  return new Date(now.getTime() + offsetMs);
}

async function createFixtureSchema() {
  await sql.unsafe(`
    drop schema if exists ${FIXTURE} cascade;
    create schema ${FIXTURE};
    create table ${FIXTURE}.salons (id uuid primary key, name text);
    create table ${FIXTURE}.mail_connections (salon_id uuid primary key, email_address text, status text not null);
    create table ${FIXTURE}.line_connections (salon_id uuid primary key, destination_id text, status text, linked_at timestamptz);
    create table ${FIXTURE}.notification_settings (salon_id uuid primary key, master_enabled boolean, new_reservation_enabled boolean, cancellation_enabled boolean);
    create table ${FIXTURE}.processed_emails (id uuid primary key default gen_random_uuid(), salon_id uuid not null, provider_message_id text not null,
      event_type text not null default 'pending', processed_at timestamptz not null default now(), unique (salon_id, provider_message_id));
    create table ${FIXTURE}.notification_history (id uuid primary key default gen_random_uuid(), salon_id uuid not null, event_type text,
      provider_message_id text, line_text text, status text, error_message text, sent_at timestamptz not null default now());
    create table ${FIXTURE}.cron_runs (id uuid primary key default gen_random_uuid(), started_at timestamptz not null, finished_at timestamptz);
    grant usage on schema ${FIXTURE} to service_role;
    grant select on all tables in schema ${FIXTURE} to service_role;
  `);
}

const ON = { master: true, nr: true, cancel: true };

async function addStaff(id: string, status: string, destination: string, settings: { master: boolean; nr: boolean; cancel: boolean }, mailbox: string) {
  await sql`insert into ${sql(FIXTURE)}.salons (id, name) values (${id}, 'スタッフ')`;
  await sql`insert into ${sql(FIXTURE)}.mail_connections (salon_id, email_address, status) values (${id}, ${mailbox}, ${status})`;
  await sql`insert into ${sql(FIXTURE)}.line_connections (salon_id, destination_id, status, linked_at) values (${id}, ${destination}, 'connected', now())`;
  await sql`insert into ${sql(FIXTURE)}.notification_settings (salon_id, master_enabled, new_reservation_enabled, cancellation_enabled)
            values (${id}, ${settings.master}, ${settings.nr}, ${settings.cancel})`;
}

async function removeStaff(id: string) {
  for (const table of ["notification_settings", "line_connections", "mail_connections"]) {
    await sql`delete from ${sql(FIXTURE)}.${sql(table)} where salon_id = ${id}`;
  }
  await sql`delete from ${sql(FIXTURE)}.salons where id = ${id}`;
}

async function hmailStatus(id: string) {
  const [row] = await sql<{ status: string }[]>`select status from ${sql(FIXTURE)}.mail_connections where salon_id = ${id}`;
  return row.status;
}

async function lineRowsFor(salonId: string) {
  const { count } = await admin.from("line_connections").select("id", { count: "exact", head: true }).eq("salon_id", salonId);
  return count ?? 0;
}

/**
 * 旧側の cron の一時停止 → 停止 → 再開後の1回分 → 停止確認、までを進める(cron_runs は全店舗で共有のため、
 * 前の場面の処理はすべて終わったものとし、停止の時刻はそれらより後にする)。
 */
async function stopAndConfirm(salonId: string) {
  await sql`update ${sql(FIXTURE)}.cron_runs set finished_at = now() where finished_at is null`;
  const [{ t }] = await sql<{ t: Date }[]>`
    select greatest(now(), coalesce(max(started_at), now())) + interval '1 second' as t from ${sql(FIXTURE)}.cron_runs`;
  const cronPausedAt = t;
  expect(await ops.stopLegacy(sql, { salonId, cronPausedAt, attestRunEnded: [], apply: true, approveHmailWrite: true, log })).toBe("stopped");
  const cronResumedAt = new Date(cronPausedAt.getTime() + 1000);
  await sql`insert into ${sql(FIXTURE)}.cron_runs (started_at, finished_at)
            values (${new Date(cronResumedAt.getTime() + 1000)}, ${new Date(cronResumedAt.getTime() + 2000)})`;
  expect(await ops.confirmCutover(sql, { salonId, cronPausedAt, cronResumedAt, attestRunEnded: [], apply: true, by: BY, log })).toBe("confirmed");
}

beforeAll(async () => {
  conns = await openDirectConnections(target, 1);
  sql = conns[0];
  await createFixtureSchema();
});

afterAll(async () => {
  for (const s of salons) await s.cleanup();
  const { data } = await admin.from("google_accounts").select("id").in("google_sub", subs);
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length > 0) {
    await admin.from("salon_google_bindings").delete().in("google_account_id", ids);
    await admin.from("google_accounts").delete().in("id", ids);
  }
  await sql.unsafe(`drop schema if exists ${FIXTURE} cascade`);
  await closeConnections(conns);
});

describe("切り替えの通し(Lavi を先に切り替え、ayana は旧側で継続): 対応表 → 静的移行 → ① 再接続 → ② 旧側の停止 → ③ 照合 → ④ 開始 → ⑤ 1回ずつ届く → 切り戻し", () => {
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  const C = crypto.randomUUID();
  const Y1 = crypto.randomUUID(); // ayana のスタッフ(旧側で継続)
  const Y2 = crypto.randomUUID();
  const E = crypto.randomUUID(); // 登録のあとに旧側に増える行
  const sub = uniqueSub();
  const google = createGoogleTestDeps({ extraUsers: [{ sub, email: LAVI_MAILBOX }] });
  let salon: TestSalonFixture;
  let otherSalon: TestSalonFixture;
  let cronPausedAt: Date;
  let cronResumedAt: Date;
  let windowFrom: Date;
  const sends: Array<{ destination: string; retryKey: string; text: string }> = [];
  const mails: Record<string, TestMail> = {};
  const boxes = new Map<string, TestInbox>();

  async function tick() {
    return pollMailForAllSalons({
      transport: google.sim.transport,
      config: google.deps.config,
      sendLine: async (destination, text, retryKey) => {
        sends.push({ destination, retryKey, text });
        return { outcome: "sent", requestId: `req-${sends.length}` };
      },
      createProvider: providersBySalon(boxes),
    });
  }

  beforeAll(async () => {
    salon = await createTestSalon();
    otherSalon = await createTestSalon();
    salons.push(salon, otherSalon);
    subs.push(sub);
    boxes.set(salon.salonId, inbox(mails));
    await addStaff(A, "connected", "U_staff_A", ON, LAVI_MAILBOX);
    await addStaff(B, "needs_reconnect", "U_staff_B", ON, " Shop@Example.test "); // 大文字・空白の違いは同じ受信箱
    await addStaff(C, "connected", "U_staff_C", { master: false, nr: true, cancel: true }, LAVI_MAILBOX);
    await addStaff(Y1, "connected", "U_ayana_1", ON, AYANA_MAILBOX);
    await addStaff(Y2, "connected", "U_ayana_2", ON, "a.yana.shop+yoyaku@gmail.com"); // Gmail のドット・+ 以降は同じ受信箱
  });

  it("対応表: 運営が確認した予約受信用 Gmail と人数を登録する。見つかった旧側のスタッフの人数が違えば登録しない", async () => {
    await expect(
      ops.registerMapping(sql, { salonId: salon.salonId, mailbox: LAVI_MAILBOX, expectedStaffCount: 2, sourceSchema: FIXTURE, note: null, apply: true, by: BY, log })
    ).rejects.toThrow(/人数が、確認した人数と一致しません/);
    expect(
      await ops.registerMapping(sql, { salonId: salon.salonId, mailbox: "SHOP@example.test", expectedStaffCount: 3, sourceSchema: FIXTURE, note: "Lavi相当", apply: true, by: BY, log })
    ).toBe("registered");
    // 同じ受信用 Gmail を別の店舗に対応付けない(Gmail アドレスから店舗を決めない)。
    await expect(
      ops.registerMapping(sql, { salonId: otherSalon.salonId, mailbox: LAVI_MAILBOX, expectedStaffCount: 3, sourceSchema: FIXTURE, note: null, apply: true, by: BY, log })
    ).rejects.toThrow(/別の店舗/);
  });

  it("静的移行: 3人中1人の指定漏れ・他店舗(ayana)の id・存在しない id は、書き込む前に拒否する", async () => {
    const ghost = crypto.randomUUID();
    for (const ids of [[A, B], [A, B, C, Y1], [A, B, C, ghost]]) {
      await expect(
        ops.staticMigrate(sql, { targetSalonId: salon.salonId, hmailSalonIds: ids, sourceSchema: FIXTURE, apply: true, by: BY, log })
      ).rejects.toThrow(/何も書き込んでいません/);
    }
    expect(await lineRowsFor(salon.salonId)).toBe(0);
    const { count } = await admin.from("legacy_cutover_snapshots").select("legacy_salon_id", { count: "exact", head: true }).eq("salon_id", salon.salonId);
    expect(count).toBe(0);
    // 対応表の無い店舗は、Gmail アドレスが一致しても移行しない。
    await expect(
      ops.staticMigrate(sql, { targetSalonId: otherSalon.salonId, hmailSalonIds: [A, B, C], sourceSchema: FIXTURE, apply: true, by: BY, log })
    ).rejects.toThrow(/何も書き込んでいません/);
  });

  it("静的移行: スタッフ全員の送信先と個人の設定を移し、切り替え待ちとして登録する(OFFだったスタッフはOFFのまま)", async () => {
    await ops.staticMigrate(sql, { targetSalonId: salon.salonId, hmailSalonIds: [A, B, C], sourceSchema: FIXTURE, apply: true, by: BY, log });
    const { data: lines } = await admin.from("line_connections").select("id, new_reservation_enabled, cancellation_enabled").eq("salon_id", salon.salonId);
    expect(lines!.find((l) => l.id === C)).toMatchObject({ new_reservation_enabled: false, cancellation_enabled: false });
    expect(lines!.find((l) => l.id === A)).toMatchObject({ new_reservation_enabled: true, cancellation_enabled: true });
    const { data: snapshots } = await admin.from("legacy_cutover_snapshots").select("legacy_salon_id, original_status").eq("salon_id", salon.salonId);
    expect(new Map(snapshots!.map((s) => [s.legacy_salon_id, s.original_status]))).toEqual(
      new Map([[A, "connected"], [B, "needs_reconnect"], [C, "connected"]])
    );
    // 同じ店舗に違う集合で登録し直すことはできない(DB の最後の防御でも拒否)。
    const { data: again } = await admin.rpc("reservation_ops_mark_legacy", {
      p_salon_id: salon.salonId,
      p_by: BY,
      p_legacy_schema: FIXTURE,
      p_snapshots: [{ legacy_salon_id: A, original_status: "connected" }],
    });
    expect(again).toBe("registered_set_differs");
  });

  it("登録のあとに同じ予約受信用 Gmail の旧側の行が増えたら「確認できない」として検出し、旧側の停止に進まない", async () => {
    await addStaff(E, "connected", "U_staff_E", ON, LAVI_MAILBOX);
    const check = await ops.legacyCheck(sql, salon.salonId);
    expect(check).toMatchObject({ driftReason: "unregistered_legacy_rows", unregisteredIds: [E] });
    await expect(
      ops.stopLegacy(sql, { salonId: salon.salonId, cronPausedAt: await dbNow(), attestRunEnded: [], apply: true, approveHmailWrite: true, log })
    ).rejects.toThrow(/スタッフの集合を確認できません/);
    expect(await hmailStatus(A)).toBe("connected"); // 何も止めていない
    await removeStaff(E);
    expect((await ops.legacyCheck(sql, salon.salonId)).driftReason).toBeNull();
  });

  it("① お客様が Google に再接続しても切り替え待ちのまま。運営は一覧で「再接続済み」と受信用 Gmail の一致を確認できる。新側はメールを読まない", async () => {
    const { result } = await connectGoogle({ ...google, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub });
    expect(result.status).toBe("connected");
    const [row] = (await ops.listOperations(sql, { awaitingOnly: true })).filter((r) => r.salonId === salon.salonId);
    expect(row).toMatchObject({
      state: "awaiting_cutover",
      legacy: true,
      googleConnection: "再接続済み",
      accountEmail: LAVI_MAILBOX,
      activatedAt: null,
      legacyMailbox: LAVI_MAILBOX,
      gmailMatchesLegacyMailbox: true,
      legacyCheck: { state: "active", reason: "legacy_rows_active" },
    });
    expect(row.firstConnectedAt).toBeInstanceOf(Date);

    expect(await customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: ["salonpack"] })).toBe("legacy_salon");
    await expect(ops.activate(sql, { salonId: salon.salonId, mailFetchSince: new Date(), reason: "x", apply: true, by: BY, log })).rejects.toThrow(/legacy_stop_not_confirmed/);

    mails["m-before"] = reservationMail(new Date());
    await tick();
    const { count } = await admin.from("processed_emails").select("id", { count: "exact", head: true }).eq("salon_id", salon.salonId);
    expect(count).toBe(0);
    expect(sends).toHaveLength(0);
    delete mails["m-before"];
  });

  it("② 旧側の停止: cron の一時停止のあと、実行中の処理の終了を確認できない間は止めない。Lavi のスタッフ全員分だけを止め、ayana の行には触れない", async () => {
    const now = await dbNow();
    windowFrom = new Date(now.getTime() - 3 * 3600_000);
    // 旧側の処理の記録: m1 は A・B が送信済み・C は設定 OFF、m2 は A がクレームしたまま履歴なし、m3 は予約メールではない。
    const t = new Date(now.getTime() - 2 * 3600_000);
    for (const [staff, status] of [[A, "sent"], [B, "sent"], [C, "skipped_disabled"]] as const) {
      await sql`insert into ${sql(FIXTURE)}.processed_emails (salon_id, provider_message_id, event_type, processed_at) values (${staff}, 'm1', 'new_reservation', ${t})`;
      await sql`insert into ${sql(FIXTURE)}.notification_history (salon_id, event_type, provider_message_id, line_text, status)
                values (${staff}, 'new_reservation', 'm1', ${status === "sent" ? "予約本文" : null}, ${status})`;
    }
    await sql`insert into ${sql(FIXTURE)}.processed_emails (salon_id, provider_message_id, event_type, processed_at) values (${A}, 'm2', 'pending', ${new Date(now.getTime() - 3600_000)})`;
    await sql`insert into ${sql(FIXTURE)}.processed_emails (salon_id, provider_message_id, event_type, processed_at) values (${A}, 'm3', 'not_hotpepper', ${t})`;
    // ayana の旧側の処理(切り替えとは無関係。照合にも停止にも含めない)。
    await sql`insert into ${sql(FIXTURE)}.processed_emails (salon_id, provider_message_id, event_type, processed_at) values (${Y1}, 'y1', 'new_reservation', ${t})`;
    const [finished] = await sql<{ id: string }[]>`insert into ${sql(FIXTURE)}.cron_runs (started_at, finished_at) values (${new Date(now.getTime() - 50 * 60_000)}, ${new Date(now.getTime() - 49 * 60_000)}) returning id`;
    const [inflight] = await sql<{ id: string }[]>`insert into ${sql(FIXTURE)}.cron_runs (started_at) values (${new Date(now.getTime() - 10 * 60_000)}) returning id`;
    expect(finished.id).toBeTruthy();
    cronPausedAt = new Date(now.getTime() - 5 * 60_000);

    // 終了の記録が無い処理がある間は止めない(時間の経過だけでは確認済みにしない)。
    await expect(ops.stopLegacy(sql, { salonId: salon.salonId, cronPausedAt, attestRunEnded: [], apply: true, approveHmailWrite: true, log })).rejects.toThrow(/attest-run-ended/);
    // 旧側への書き込みは明示的な承認が必要。
    await expect(ops.stopLegacy(sql, { salonId: salon.salonId, cronPausedAt, attestRunEnded: [inflight.id], apply: true, approveHmailWrite: false, log })).rejects.toThrow(/approve-hmail-write/);
    expect(await ops.stopLegacy(sql, { salonId: salon.salonId, cronPausedAt, attestRunEnded: [inflight.id], apply: true, approveHmailWrite: true, log })).toBe("stopped");
    for (const id of [A, B, C]) expect(await hmailStatus(id)).toBe(ops.LEGACY_STOPPED_STATUS);
    // ayana は旧側で継続(行の状態は変えない)。
    expect(await hmailStatus(Y1)).toBe("connected");
    expect(await hmailStatus(Y2)).toBe("connected");
    // 行は削除していない。
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from ${sql(FIXTURE)}.mail_connections where salon_id = any(${[A, B, C]})`;
    expect(count).toBe(3);
    // cron の再開と、再開後の1回分の処理。
    cronResumedAt = await dbNow();
    await sql`insert into ${sql(FIXTURE)}.cron_runs (started_at, finished_at) values (${await dbNow(1000)}, ${await dbNow(2000)})`;
    (globalThis as Record<string, unknown>).__inflightRun = inflight.id;
  });

  it("停止の確認: 旧側の処理が状態を書き戻していた・同じ受信用 Gmail の行が増えていたら確認しない。止まっていれば記録する(ayana の行が動いていても Lavi の確認には影響しない)", async () => {
    const inflightRun = (globalThis as Record<string, unknown>).__inflightRun as string;
    const confirm = () =>
      ops.confirmCutover(sql, { salonId: salon.salonId, cronPausedAt, cronResumedAt, attestRunEnded: [inflightRun], apply: true, by: BY, log });
    // 実行中だった旧側の処理が「接続済み」を書き戻した(hmail の recordMailCheckSuccess)。
    await sql`update ${sql(FIXTURE)}.mail_connections set status = 'connected' where salon_id = ${A}`;
    await expect(confirm()).rejects.toThrow();
    await sql`update ${sql(FIXTURE)}.mail_connections set status = ${ops.LEGACY_STOPPED_STATUS} where salon_id = ${A}`;
    // 登録のあとに、同じ受信用 Gmail の行が増えた(処理対象でない状態でも、集合が変わったので確認しない)。
    await addStaff(E, "disconnected", "U_staff_E", ON, LAVI_MAILBOX);
    await expect(confirm()).rejects.toThrow();
    await removeStaff(E);
    expect(await confirm()).toBe("confirmed");
  });

  it("③ 照合: メール×スタッフごとに送信済み・引き継ぎ・結果不明を分け、未解決があるうちは受け入れない(ayana の記録は含めない)", async () => {
    const first = await ops.reconcile(sql, { salonId: salon.salonId, windowFrom, apply: true, by: BY, log });
    expect(first.counts).toMatchObject({ sent: 2, skipped: 1, needs_review: 1, handover: 2, not_hotpepper_emails: 1, partially_handled_emails: 1 });
    expect(first.unresolved).toBe(1);
    await expect(ops.acceptReconciliation(sql, { runId: first.runId!, by: BY, log })).rejects.toThrow(/unresolved_remaining/);
    const { count: ayanaRows } = await admin.from("processed_emails").select("id", { count: "exact", head: true }).eq("provider_message_id", "y1");
    expect(ayanaRows).toBe(0);

    // 結果不明は自動では送らない。運営が確認して決める(ここでは「送らない」と判断)。
    const { data: review } = await admin.from("notification_deliveries").select("id, line_connection_id, provider_message_id").eq("salon_id", salon.salonId).eq("status", "needs_review");
    expect(review).toEqual([expect.objectContaining({ line_connection_id: A, provider_message_id: "m2" })]);
    await ops.resolveDelivery(sql, { deliveryId: review![0].id, mode: "skipped", reason: "旧側で送信済みと確認", acceptDuplicateRisk: false, apply: true, by: BY, log });

    // 照合をもう一度(解決済みの記録は上書きしない)→ 受け入れ。
    const second = await ops.reconcile(sql, { salonId: salon.salonId, windowFrom, apply: true, by: BY, log });
    expect(second.unresolved).toBe(0);
    await ops.acceptReconciliation(sql, { runId: second.runId!, by: BY, log });
    const { data: resolved } = await admin.from("notification_deliveries").select("status").eq("id", review![0].id).single();
    expect(resolved!.status).toBe("skipped");
  });

  it("④ 開始の前に、照合した範囲より前から読む指定・旧側の行の増加は拒否する", async () => {
    await expect(
      ops.activate(sql, { salonId: salon.salonId, mailFetchSince: new Date(windowFrom.getTime() - 3600_000), reason: "x", apply: true, by: BY, log })
    ).rejects.toThrow(/照合した範囲より前/);
    const { error } = await admin.rpc("reservation_ops_activate", {
      p_salon_id: salon.salonId,
      p_by: BY,
      p_mail_fetch_since: new Date(windowFrom.getTime() - 3600_000).toISOString(),
      p_reason: "x",
    });
    expect(error?.message).toContain("reservation_ops:fetch_start_before_reconciliation_window");
    await addStaff(E, "disconnected", "U_staff_E", ON, LAVI_MAILBOX);
    await expect(ops.activate(sql, { salonId: salon.salonId, mailFetchSince: null, reason: null, apply: true, by: BY, log })).rejects.toThrow(/legacy_not_stopped:unknown/);
    await removeStaff(E);
  });

  it("④ 開始 → ⑤ 新規予約とキャンセルが、対象のスタッフに1回ずつ届く(旧側で送信済みの組には送らない。再接続より前に届いた未送信のメールも届く)", async () => {
    expect(await ops.activate(sql, { salonId: salon.salonId, mailFetchSince: null, reason: null, apply: true, by: BY, log })).toBe("activated");
    const { data: opsRow } = await admin.from("reservation_notification_operations").select("state, mail_fetch_since_reason").eq("salon_id", salon.salonId).single();
    expect(opsRow).toEqual({ state: "active", mail_fetch_since_reason: "reconciliation_window" });

    const now = await dbNow();
    // m1・m2 は、お客様が再接続(①)するより前に届いたメール。取得開始は照合の範囲の始め(接続日時ではない)。
    mails.m1 = reservationMail(new Date(now.getTime() - 2 * 3600_000), "m1");
    mails.m2 = reservationMail(new Date(now.getTime() - 3600_000), "m2");
    mails.m4 = reservationMail(now, "m4");
    mails.m5 = reservationMail(now, "m5", "キャンセル連絡");
    await tick();
    await tick(); // 2回目で重複が起きないこと

    const pairs = sends.map((s) => `${s.destination}`);
    // m2 → B だけ(A は旧側で決着、C は通知 OFF)。m4・m5 → A と B(C は OFF)。
    expect(pairs.sort()).toEqual(["U_staff_A", "U_staff_A", "U_staff_B", "U_staff_B", "U_staff_B"]);
    expect(sends.some((s) => s.destination === "U_staff_C" || s.destination.startsWith("U_ayana"))).toBe(false);
    const { data: rows } = await admin.from("notification_deliveries").select("provider_message_id, line_connection_id, status, origin").eq("salon_id", salon.salonId);
    const sentSalonpack = rows!.filter((r) => r.origin === "salonpack" && r.status === "sent").map((r) => `${r.provider_message_id}:${r.line_connection_id}`);
    expect(new Set(sentSalonpack).size).toBe(sentSalonpack.length);
    expect(sentSalonpack.sort()).toEqual([`m2:${B}`, `m4:${A}`, `m4:${B}`, `m5:${A}`, `m5:${B}`].sort());
    expect(rows!.filter((r) => r.line_connection_id === C && r.origin === "salonpack").every((r) => r.status === "skipped")).toBe(true);
  });

  it("稼働中に旧側が再び動いたら(監視)、新側を自動で止めて送らない", async () => {
    await sql`update ${sql(FIXTURE)}.mail_connections set status = 'connected' where salon_id = ${B}`;
    const before = sends.length;
    mails.m6 = reservationMail(await dbNow(), "m6");
    await tick();
    expect(sends.length).toBe(before);
    const { data: opsRow } = await admin.from("reservation_notification_operations").select("state, pause_reason").eq("salon_id", salon.salonId).single();
    expect(opsRow).toEqual({ state: "paused", pause_reason: "legacy_active" });
    await sql`update ${sql(FIXTURE)}.mail_connections set status = ${ops.LEGACY_STOPPED_STATUS} where salon_id = ${B}`;
    delete mails.m6;
  });

  it("稼働中に同じ受信用 Gmail の旧側の行が増えたら(監視)、確認できないとして止める。開始もできない", async () => {
    await admin.rpc("reservation_ops_activate", { p_salon_id: salon.salonId, p_by: BY, p_mail_fetch_since: null, p_reason: null });
    const { data: active } = await admin.from("reservation_notification_operations").select("state").eq("salon_id", salon.salonId).single();
    expect(active!.state).toBe("active");
    await addStaff(E, "disconnected", "U_staff_E", ON, LAVI_MAILBOX);
    const before = sends.length;
    mails.m7 = reservationMail(await dbNow(), "m7");
    await tick();
    expect(sends.length).toBe(before);
    const { data: opsRow } = await admin.from("reservation_notification_operations").select("state, pause_reason").eq("salon_id", salon.salonId).single();
    expect(opsRow).toEqual({ state: "paused", pause_reason: "legacy_unknown" });
    const { error } = await admin.rpc("reservation_ops_activate", { p_salon_id: salon.salonId, p_by: BY, p_mail_fetch_since: null, p_reason: null });
    expect(error?.message).toContain("reservation_ops:legacy_not_stopped:unknown");
    await removeStaff(E);
    delete mails.m7;
  });

  it("監視の権限が無い・旧側の状態を確認できない場合は、開始を拒否する(確認できないものは止める)", async () => {
    await sql.unsafe(`revoke select on ${FIXTURE}.mail_connections from service_role`);
    try {
      const { data: state } = await admin.rpc("reservation_ops_legacy_state", { p_salon_id: salon.salonId });
      expect(state).toBe("unknown");
      const { error } = await admin.rpc("reservation_ops_activate", { p_salon_id: salon.salonId, p_by: BY, p_mail_fetch_since: null, p_reason: null });
      expect(error?.message).toContain("reservation_ops:legacy_not_stopped:unknown");
    } finally {
      await sql.unsafe(`grant select on ${FIXTURE}.mail_connections to service_role`);
    }
  });

  it("切り戻し: 新側が送信した後は A を使えない。B はメール×スタッフごとに旧側の処理済みを登録し、スタッフごとの元の状態へ戻す(ayana は変えない)", async () => {
    await expect(ops.rollback(sql, { salonId: salon.salonId, mode: "A", apply: true, approveHmailWrite: true, by: BY, log })).rejects.toThrow(/切り戻しAは使えません/);
    const result = await ops.rollback(sql, { salonId: salon.salonId, mode: "B", apply: true, approveHmailWrite: true, by: BY, log });
    expect(result.held).toEqual([]);
    const marked = await sql<{ salon_id: string; provider_message_id: string }[]>`
      select salon_id::text, provider_message_id from ${sql(FIXTURE)}.processed_emails where provider_message_id in ('m4', 'm5') order by 1, 2`;
    // 送信済み(A・B)と、送らないと決めた(C)の組だけ。メール全体を一律に処理済みにはしない。
    expect(marked.map((m) => `${m.provider_message_id}:${m.salon_id}`).sort()).toEqual([`m4:${A}`, `m4:${B}`, `m4:${C}`, `m5:${A}`, `m5:${B}`, `m5:${C}`].sort());
    // 元の状態へ(全員を無条件に connected にしない)。
    expect(await hmailStatus(A)).toBe("connected");
    expect(await hmailStatus(B)).toBe("needs_reconnect");
    expect(await hmailStatus(C)).toBe("connected");
    expect(await hmailStatus(Y1)).toBe("connected");
    const { data: opsRow } = await admin.from("reservation_notification_operations").select("state, legacy_stop_confirmed_at, accepted_reconciliation_id").eq("salon_id", salon.salonId).single();
    expect(opsRow).toEqual({ state: "awaiting_cutover", legacy_stop_confirmed_at: null, accepted_reconciliation_id: null });
  });

  it("別の店舗へ登録済みのスタッフは、他の店舗の移行に混ぜられない(CLI と DB の両方で拒否)", async () => {
    const O1 = crypto.randomUUID();
    await addStaff(O1, "connected", "U_other_1", ON, "other@example.test");
    await ops.registerMapping(sql, { salonId: otherSalon.salonId, mailbox: "other@example.test", expectedStaffCount: 1, sourceSchema: FIXTURE, note: null, apply: true, by: BY, log });
    await expect(
      ops.staticMigrate(sql, { targetSalonId: otherSalon.salonId, hmailSalonIds: [O1, A], sourceSchema: FIXTURE, apply: true, by: BY, log })
    ).rejects.toThrow(/何も書き込んでいません/);
    const { data } = await admin.rpc("reservation_ops_mark_legacy", {
      p_salon_id: otherSalon.salonId,
      p_by: BY,
      p_legacy_schema: FIXTURE,
      p_snapshots: [{ legacy_salon_id: A, original_status: "connected" }],
    });
    expect(data).toBe("staff_registered_elsewhere");
    expect(await lineRowsFor(otherSalon.salonId)).toBe(0);
  });
});

describe("切り戻しA(新側がまだ送信を試みていない)", () => {
  it("スタッフごとの元の状態へ戻し、結果不明の保留は無い", async () => {
    const salon = await createTestSalon();
    salons.push(salon);
    const D = crypto.randomUUID();
    await addStaff(D, "needs_reconnect", "U_staff_D", ON, "shop-d@example.test");
    await ops.registerMapping(sql, { salonId: salon.salonId, mailbox: "shop-d@example.test", expectedStaffCount: 1, sourceSchema: FIXTURE, note: null, apply: true, by: BY, log });
    await ops.staticMigrate(sql, { targetSalonId: salon.salonId, hmailSalonIds: [D], sourceSchema: FIXTURE, apply: true, by: BY, log });
    // cron の履歴は旧側全体で共有。前の場面で実行中だった処理は、その後に終わっている。
    await sql`update ${sql(FIXTURE)}.cron_runs set finished_at = now() where finished_at is null`;
    const [{ t: pausedAt }] = await sql<{ t: Date }[]>`
      select greatest(now(), coalesce(max(started_at), now())) + interval '1 second' as t from ${sql(FIXTURE)}.cron_runs`;
    await ops.stopLegacy(sql, { salonId: salon.salonId, cronPausedAt: pausedAt, attestRunEnded: [], apply: true, approveHmailWrite: true, log });
    expect(await hmailStatus(D)).toBe(ops.LEGACY_STOPPED_STATUS);
    const result = await ops.rollback(sql, { salonId: salon.salonId, mode: "A", apply: true, approveHmailWrite: true, by: BY, log });
    expect(result.held).toEqual([]);
    expect(await hmailStatus(D)).toBe("needs_reconnect");
  });
});

describe("取得開始日時の回帰: 9時から取得・10時に接続・9時30分の未処理メール", () => {
  // DB の現在時刻 T を「12時」とみなす: 9時 = T-3h、9時15分 = T-2h45m、9時30分 = T-2h30m、10時 = T-2h。
  const R1 = crypto.randomUUID();
  const R2 = crypto.randomUUID();
  const MAILBOX = "regress.shop@gmail.com";
  const rightSub = uniqueSub();
  const wrongSub = uniqueSub();
  const google = createGoogleTestDeps({
    extraUsers: [
      { sub: rightSub, email: "Regress.Shop@gmail.com" },
      { sub: wrongSub, email: "owner-personal@example.test" },
    ],
  });
  const mails: Record<string, TestMail> = {};
  const boxes = new Map<string, TestInbox>();
  const sends: Array<{ destination: string; retryKey: string; body: string }> = [];
  let salon: TestSalonFixture;
  let T: Date;
  const at = (hoursBeforeNoon: number) => new Date(T.getTime() - hoursBeforeNoon * 3600_000);

  const tick = () =>
    pollMailForAllSalons({
      transport: google.sim.transport,
      config: google.deps.config,
      sendLine: async (destination, text, retryKey) => {
        sends.push({ destination, retryKey, body: text });
        return { outcome: "sent", requestId: `r-${sends.length}` };
      },
      createProvider: providersBySalon(boxes),
    });

  beforeAll(async () => {
    salon = await createTestSalon();
    salons.push(salon);
    subs.push(rightSub, wrongSub);
    boxes.set(salon.salonId, inbox(mails));
    T = await dbNow();
    await addStaff(R1, "connected", "U_regress_1", ON, MAILBOX);
    await addStaff(R2, "connected", "U_regress_2", ON, MAILBOX);
  });

  it("10時の再接続より前(9時30分)に届き、旧側でも処理されていないメールを取り込み、スタッフ全員に1回ずつ届ける", async () => {
    await ops.registerMapping(sql, { salonId: salon.salonId, mailbox: MAILBOX, expectedStaffCount: 2, sourceSchema: FIXTURE, note: null, apply: true, by: BY, log });
    await ops.staticMigrate(sql, { targetSalonId: salon.salonId, hmailSalonIds: [R1, R2], sourceSchema: FIXTURE, apply: true, by: BY, log });

    // お客様が最初は別の(個人の)Google アカウントで連携してしまった → 開始は拒否される。
    await connectGoogle({ ...google, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: wrongSub });

    // 旧側の記録: 9時15分のメールは2人とも送信済み。8時30分(照合の範囲の前)・9時30分のメールは旧側の記録なし。
    for (const staff of [R1, R2]) {
      await sql`insert into ${sql(FIXTURE)}.processed_emails (salon_id, provider_message_id, event_type, processed_at) values (${staff}, 'r915', 'new_reservation', ${at(2.75)})`;
      await sql`insert into ${sql(FIXTURE)}.notification_history (salon_id, event_type, provider_message_id, line_text, status) values (${staff}, 'new_reservation', 'r915', '本文', 'sent')`;
    }
    await stopAndConfirm(salon.salonId);
    const run = await ops.reconcile(sql, { salonId: salon.salonId, windowFrom: at(3), apply: true, by: BY, log });
    expect(run.unresolved).toBe(0);
    await ops.acceptReconciliation(sql, { runId: run.runId!, by: BY, log });

    await expect(ops.activate(sql, { salonId: salon.salonId, mailFetchSince: null, reason: null, apply: true, by: BY, log })).rejects.toThrow(/gmail_account_mismatch/);

    // 正しい受信箱へ切り替え(運用状態は変わらない)。接続した日時を「10時」にする。
    const { result } = await connectGoogle({ ...google, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: rightSub, purpose: "switch_account" });
    expect(result.status).toBe("connected");
    await admin
      .from("salon_google_bindings")
      .update({ first_connected_at: at(2).toISOString(), account_bound_at: at(2).toISOString(), last_reconnected_at: at(2).toISOString() })
      .eq("salon_id", salon.salonId)
      .eq("feature", "gmail");

    expect(await ops.activate(sql, { salonId: salon.salonId, mailFetchSince: null, reason: null, apply: true, by: BY, log })).toBe("activated");
    const { data: opsRow } = await admin.from("reservation_notification_operations").select("mail_fetch_since, mail_fetch_account_id").eq("salon_id", salon.salonId).single();
    expect(new Date(opsRow!.mail_fetch_since).getTime()).toBe(at(3).getTime()); // 9時(接続した10時ではない)
    expect(opsRow!.mail_fetch_account_id).toBeTruthy();

    mails.r830 = reservationMail(at(3.5), "r830"); // 照合の範囲より前: 読まない
    mails.r915 = reservationMail(at(2.75), "r915"); // 旧側で送信済み: 送らない
    mails.r930 = reservationMail(at(2.5), "r930"); // 再接続より前・旧側の記録なし: 送る
    await tick();
    await tick();

    expect(sends.map((s) => s.destination).sort()).toEqual(["U_regress_1", "U_regress_2"]);
    const { data: rows } = await admin.from("notification_deliveries").select("provider_message_id, line_connection_id, status, origin").eq("salon_id", salon.salonId).eq("origin", "salonpack");
    expect(rows!.map((r) => `${r.provider_message_id}:${r.line_connection_id}:${r.status}`).sort()).toEqual([`r930:${R1}:sent`, `r930:${R2}:sent`].sort());
    expect(sends).toHaveLength(2);
    const { count: r830 } = await admin.from("processed_emails").select("id", { count: "exact", head: true }).eq("salon_id", salon.salonId).eq("provider_message_id", "r830");
    expect(r830).toBe(0);
    await admin.rpc("reservation_ops_pause", { p_salon_id: salon.salonId, p_by: BY, p_reason: "test_done", p_kind: "operator_pause" });
  });
});
