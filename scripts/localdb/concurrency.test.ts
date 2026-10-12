// 権限の更新と、送信直前の確認・契約変更・運用状態の操作の同時実行(0024 のロックの手順)。
// 2つの接続でトランザクションを開いたまま、もう一方が待つこと・待ったあとに最新の値で判定することを確かめる。
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReservedSql, Sql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { addDelivery, beginSend, claim, createOperator, createSalon, makeReservationActive, openHolds, stateOf } from "./fixtures";

const DB = "salonpack_localdb_concurrency";
let sql: Sql;
let operator: string;

beforeAll(async () => {
  sql = await createDatabase(DB);
  operator = await createOperator(sql);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

async function pidOf(conn: ReservedSql): Promise<number> {
  const [{ pid }] = await conn<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return pid;
}

/** pid の接続がロック待ちになるまで待つ(最大 5 秒)。 */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const rows = await sql`select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'`;
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} がロック待ちになりませんでした`);
}

async function isBlocked(pid: number): Promise<boolean> {
  const rows = await sql`select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'`;
  return rows.length > 0;
}

// postgres.js の問い合わせは await されるまで送られないため、execute() ですぐに送る(待たせる側の確認に使う)。
function saveDeny(conn: Sql | ReservedSql, salonId: string, version: number, key = "reservation_notifications", from = "inherit", to = "deny") {
  return conn<{ r: { result: string; inflight_sends: number } }[]>`
    select public.admin_update_salon_entitlements(${operator}, ${salonId}, ${version},
      ${conn.json({ plan: "salonpack", overrides: { [key]: from } })}, ${conn.json({ overrides: { [key]: to } })}, null, ${randomUUID()}) as r`.execute();
}

describe("送信直前の確認と、利用不可の保存", () => {
  it("送信開始中(共有ロック中)の保存は待ち、保存後に新しい送信は始まらない。待った分は送信開始済みとして数える", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, s.salonId);
    await addDelivery(sql, s.salonId, lineConnectionId);
    const c1 = (await claim(sql, s.salonId))!;
    await addDelivery(sql, s.salonId, lineConnectionId);
    const c2 = (await claim(sql, s.salonId))!;

    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a`begin`;
      expect(await beginSend(a as unknown as Sql, c1)).toEqual({ decision: "send", reason: null });
      const bPid = await pidOf(b);
      const pending = saveDeny(b, s.salonId, 0);
      await waitUntilBlocked(bPid);
      await a`commit`;
      const [{ r }] = await pending;
      expect(r.result).toBe("saved");
      expect(r.inflight_sends).toBe(1);
    } finally {
      a.release();
      b.release();
    }
    // 保存のあと: 取り出し済みの配信も送信を始めない
    expect(await beginSend(sql, c2)).toEqual({ decision: "released", reason: "not_entitled" });
    const [d2] = await sql`select send_started_at, status from public.notification_deliveries where id = ${c2.id}`;
    expect(d2.send_started_at).toBeNull();
    expect(d2.status).toBe("pending");
    expect(await claim(sql, s.salonId)).toBeNull();
  });

  it("保存(未コミット)中の送信開始は待ち、コミット後は止まる。取り消されたら送る", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, s.salonId);
    await addDelivery(sql, s.salonId, lineConnectionId);
    const c1 = (await claim(sql, s.salonId))!;
    await addDelivery(sql, s.salonId, lineConnectionId);
    const c2 = (await claim(sql, s.salonId))!;

    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      // 取り消し(rollback)の場合: 待ったあと、送る
      await b`begin`;
      await saveDeny(b, s.salonId, 0);
      const aPid = await pidOf(a);
      const sending = beginSend(a as unknown as Sql, c1);
      await waitUntilBlocked(aPid);
      await b`rollback`;
      expect(await sending).toEqual({ decision: "send", reason: null });

      // コミットの場合: 待ったあと、止まる
      await b`begin`;
      const [{ r }] = await saveDeny(b, s.salonId, 0);
      expect(r.result).toBe("saved");
      const blocked = beginSend(a as unknown as Sql, c2);
      await waitUntilBlocked(aPid);
      await b`commit`;
      expect(await blocked).toEqual({ decision: "released", reason: "not_entitled" });
    } finally {
      a.release();
      b.release();
    }
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
  });

  it("CLI・SQL Editor での契約変更も同じロックで直列になる", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, s.salonId);
    await addDelivery(sql, s.salonId, lineConnectionId);
    const c1 = (await claim(sql, s.salonId))!;
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await b`begin`;
      await b`update public.salons set plan = 'reviews' where id = ${s.salonId}`;
      const aPid = await pidOf(a);
      const sending = beginSend(a as unknown as Sql, c1);
      await waitUntilBlocked(aPid);
      await b`commit`;
      expect(await sending).toEqual({ decision: "released", reason: "not_entitled" });
    } finally {
      a.release();
      b.release();
    }
  });

  it("運営による停止(運用状態の行のロック)とは独立に進み、互いを待たない", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, s.salonId);
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a`begin`;
      await a`select public.reservation_ops_pause(${s.salonId}, 'test', 'テスト', 'operator_pause')`;
      const bPid = await pidOf(b);
      const saving = saveDeny(b, s.salonId, 0);
      await new Promise((r) => setTimeout(r, 200));
      expect(await isBlocked(bPid)).toBe(false);
      const [{ r }] = await saving;
      expect(r.result).toBe("saved");
      await a`commit`;
    } finally {
      a.release();
      b.release();
    }
  });
});

describe("同時の保存", () => {
  it("基準行が無い店舗の初回の保存が同時に来ても、片方だけ保存され、もう片方は conflict", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    await sql`delete from public.salon_entitlement_state where salon_id = ${s.salonId}`;
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a`begin`;
      const [{ r: ra }] = await saveDeny(a, s.salonId, 0, "blog");
      const bPid = await pidOf(b);
      const second = saveDeny(b, s.salonId, 0, "blog", "inherit", "allow");
      await waitUntilBlocked(bPid);
      await a`commit`;
      const [{ r: rb }] = await second;
      expect(ra.result).toBe("saved");
      expect(rb.result).toBe("conflict");
    } finally {
      a.release();
      b.release();
    }
    const [o] = await sql`select mode from public.salon_feature_overrides where salon_id = ${s.salonId} and feature_key = 'blog'`;
    expect(o.mode).toBe("deny");
  });
});

describe("いろいろな操作を同時に繰り返しても、デッドロックせず、最後の利用不可のあとは送らない", () => {
  it("送信・保存・契約変更・運営の停止と再開・解除を混ぜて実行する", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, s.salonId);
    const errors: unknown[] = [];
    const guard = (p: Promise<unknown>) => p.catch((e) => errors.push(e));

    for (let round = 0; round < 15; round++) {
      for (let i = 0; i < 3; i++) await addDelivery(sql, s.salonId, lineConnectionId);
      const { version } = await stateOf(sql, s.salonId);
      const [o] = await sql`select coalesce((select mode from public.salon_feature_overrides where salon_id = ${s.salonId} and feature_key = 'reservation_notifications'), 'inherit') as mode`;
      const next = o.mode === "deny" ? "inherit" : "deny";
      await Promise.all([
        guard((async () => {
          for (let i = 0; i < 3; i++) {
            const c = await claim(sql, s.salonId);
            if (c) await beginSend(sql, c);
          }
        })()),
        guard(saveDeny(sql, s.salonId, version, "reservation_notifications", o.mode as string, next)),
        guard(sql.begin(async (tx) => {
          await tx`update public.salons set plan = 'salonpack', updated_at = now() where id = ${s.salonId}`;
        })),
        guard(sql`select public.reservation_ops_pause(${s.salonId}, 'test', 'テスト', 'operator_pause')`.then(() =>
          sql`select public.reservation_ops_activate(${s.salonId}, 'test', null, null)`,
        )),
        guard(sql`select public.feature_hold_release(${operator}, ${s.salonId}, 'reservation_notifications', null, null, null)`),
      ]);
    }
    expect(errors).toEqual([]);

    // 最後に利用不可にして、そのあとは送信を始めない
    const { version } = await stateOf(sql, s.salonId);
    const [o] = await sql`select coalesce((select mode from public.salon_feature_overrides where salon_id = ${s.salonId} and feature_key = 'reservation_notifications'), 'inherit') as mode`;
    if (o.mode !== "deny") {
      const [{ r }] = await saveDeny(sql, s.salonId, version, "reservation_notifications", o.mode as string, "deny");
      expect(r.result).toBe("saved");
    }
    const [{ t }] = await sql<{ t: Date }[]>`select clock_timestamp() as t`;
    await addDelivery(sql, s.salonId, lineConnectionId);
    expect(await claim(sql, s.salonId)).toBeNull();
    const later = await sql`select count(*)::int as n from public.notification_deliveries where salon_id = ${s.salonId} and send_started_at > ${t}`;
    expect(later[0].n).toBe(0);
  });
});
