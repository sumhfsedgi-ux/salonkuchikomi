// 0023 までの DB に既存店舗がある状態で 0024 を適用し、利用可否・稼働状態が変わらないこと、
// 再適用しても同じ結果になることを確かめる。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { applyFile, createDatabase, dropDatabase, migrationFiles } from "./db";
import { addDelivery, beginSend, claim, createSalon, makeReservationActive, openHolds, openStops, stateOf } from "./fixtures";

const DB = "salonpack_localdb_migration";
let sql: Sql;
const m0024 = migrationFiles().find((f) => f.includes("0024_"))!;

let activeSalonpack: string;
let activeSalonpackLine: string;
let downgraded: string;
let reviewsOnly: string;
let pendingDowngraded: string;

beforeAll(async () => {
  sql = await createDatabase(DB, "0023");
  activeSalonpack = (await createSalon(sql, { plan: "salonpack" })).salonId;
  activeSalonpackLine = (await makeReservationActive(sql, activeSalonpack)).lineConnectionId;
  // salonpack で稼働していたが、0022 のあとに reviews に変えた店舗(contract の停止期間が開いている)
  downgraded = (await createSalon(sql, { plan: "salonpack" })).salonId;
  await makeReservationActive(sql, downgraded);
  await sql`update public.salons set plan = 'reviews' where id = ${downgraded}`;
  reviewsOnly = (await createSalon(sql, { plan: "reviews" })).salonId;
  pendingDowngraded = (await createSalon(sql, { plan: "reviews" })).salonId;
  await sql`insert into public.reservation_notification_operations (salon_id) values (${pendingDowngraded})`;
  await applyFile(sql, m0024);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

describe("0024 の適用", () => {
  it("既存店舗の利用可否は今の契約と同じで、版数は 0", async () => {
    expect(await stateOf(sql, activeSalonpack)).toEqual({ version: 0, committed: { reviews: true, blog: true, reservation_notifications: true } });
    expect(await stateOf(sql, reviewsOnly)).toEqual({ version: 0, committed: { reviews: true, blog: false, reservation_notifications: false } });
  });

  it("稼働中の店舗はそのまま送れる(停止を開かない)", async () => {
    expect(await openHolds(sql, activeSalonpack)).toEqual([]);
    expect(await openStops(sql, activeSalonpack)).toEqual([]);
    await addDelivery(sql, activeSalonpack, activeSalonpackLine);
    const c = await claim(sql, activeSalonpack, ["salonpack"]);
    expect(await beginSend(sql, c!, ["salonpack"])).toEqual({ decision: "send", reason: null });
  });

  it("契約で止まっている稼働済みの店舗には、権限による停止を記録する(今も送っていない。戻しても自動で再開させない)", async () => {
    expect(await openHolds(sql, downgraded)).toEqual(["reservation_notifications"]);
    expect(await openStops(sql, downgraded)).toEqual(["contract"]);
    await sql`update public.salons set plan = 'salonpack' where id = ${downgraded}`;
    expect(await openHolds(sql, downgraded)).toEqual(["reservation_notifications"]);
    const pollable = await sql`select 1 from public.notifications_list_pollable_salons(null) where salon_id = ${downgraded}`;
    expect(pollable.length).toBe(0);
  });

  it("開始前の店舗・予約通知を使っていない店舗には記録しない", async () => {
    expect(await openHolds(sql, pendingDowngraded)).toEqual([]);
    expect(await openHolds(sql, reviewsOnly)).toEqual([]);
  });

  it("0022 以降の契約変更の記録を操作履歴に写す", async () => {
    const logs = await sql`select target, before, after, actor_kind from public.operator_audit_log where salon_id = ${downgraded} order by id`;
    expect(logs[0]).toEqual({ target: "plan", before: "salonpack", after: "reviews", actor_kind: "sql" });
  });

  it("再適用しても、履歴・停止・基準行は重複しない", async () => {
    const count = async () => {
      const [r] = await sql`select (select count(*) from public.operator_audit_log)::int as logs, (select count(*) from public.salon_feature_holds)::int as holds,
                                   (select count(*) from public.salon_entitlement_state)::int as states, (select count(*) from public.reservation_stop_intervals)::int as stops`;
      return r;
    };
    const before = await count();
    await applyFile(sql, m0024);
    expect(await count()).toEqual(before);
  });
});
