// 0024(運営管理・利用権限)の DB の動きを、ローカルの PostgreSQL で確かめる(npm run test:localdb)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import {
  addDelivery,
  adminSave,
  beginSend,
  claim,
  createOperator,
  createSalon,
  makeReservationActive,
  openHolds,
  openStops,
  stateOf,
} from "./fixtures";

const DB = "salonpack_localdb_entitlements";
let sql: Sql;
let operator: string;

beforeAll(async () => {
  sql = await createDatabase(DB);
  operator = await createOperator(sql);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

async function access(salonId: string, key: string) {
  const [row] = await sql<{ allowed: boolean; reason: string }[]>`select * from public.salon_feature_access(${salonId}, ${key})`;
  return row;
}

async function overrideMode(salonId: string, key: string): Promise<string> {
  const [row] = await sql<{ mode: string }[]>`select mode from public.salon_feature_overrides where salon_id = ${salonId} and feature_key = ${key}`;
  return row?.mode ?? "inherit";
}

async function save(salonId: string, changes: { plan?: string; overrides?: Record<string, string> }, note?: string) {
  const [s] = await sql<{ plan: string }[]>`select plan from public.salons where id = ${salonId}`;
  const { version } = await stateOf(sql, salonId);
  const expectedOverrides: Record<string, string> = {};
  for (const key of Object.keys(changes.overrides ?? {})) expectedOverrides[key] = await overrideMode(salonId, key);
  return adminSave(sql, {
    actor: operator,
    salonId,
    expectedVersion: version,
    expected: { plan: s.plan, overrides: expectedOverrides },
    changes,
    note,
  });
}

describe("導入時(既存店舗の利用可否を変えない)", () => {
  it("新しい店舗にも基準行ができ、利用可否は今の契約と同じ", async () => {
    const r = await createSalon(sql, { plan: "reviews" });
    const p = await createSalon(sql, { plan: "salonpack" });
    expect((await stateOf(sql, r.salonId)).committed).toEqual({ reviews: true, blog: false, reservation_notifications: false });
    expect((await stateOf(sql, p.salonId)).committed).toEqual({ reviews: true, blog: true, reservation_notifications: true });
    expect((await stateOf(sql, p.salonId)).version).toBe(0);
    expect(await openHolds(sql, p.salonId)).toEqual([]);
  });
});

describe("判定の順(対象プラン・提供状態は個別設定で解除できない)", () => {
  it("口コミプランへのブログの個別許可は効かない(対象外)", async () => {
    const r = await createSalon(sql, { plan: "reviews" });
    await sql`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${r.salonId}, 'blog', 'allow')`;
    expect(await access(r.salonId, "blog")).toEqual({ allowed: false, reason: "not_in_plan" });
  });

  it("個別に利用不可・個別に許可・標準", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    expect(await access(p.salonId, "blog")).toEqual({ allowed: true, reason: "plan_default" });
    await sql`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${p.salonId}, 'blog', 'deny')`;
    expect(await access(p.salonId, "blog")).toEqual({ allowed: false, reason: "override_deny" });
    await sql`update public.salon_feature_overrides set mode = 'allow' where salon_id = ${p.salonId} and feature_key = 'blog'`;
    expect(await access(p.salonId, "blog")).toEqual({ allowed: true, reason: "override_allow" });
  });

  it("標準で含めない機能も、対象プランなら個別に許可できる。準備中・提供終了は個別許可でも使えない", async () => {
    await sql.begin(async (tx) => {
      const p = await createSalon(tx as unknown as Sql, { plan: "salonpack" });
      await tx`insert into public.feature_catalog (feature_key, lifecycle) values ('test_future', 'available')`;
      await tx`insert into public.plan_feature_rules (plan, feature_key, default_enabled) values ('salonpack', 'test_future', false)`;
      const a1 = await tx`select * from public.salon_feature_access(${p.salonId}, 'test_future')`;
      expect(a1[0]).toEqual({ allowed: false, reason: "plan_default_off" });
      await tx`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${p.salonId}, 'test_future', 'allow')`;
      const a2 = await tx`select * from public.salon_feature_access(${p.salonId}, 'test_future')`;
      expect(a2[0]).toEqual({ allowed: true, reason: "override_allow" });
      await tx`update public.feature_catalog set lifecycle = 'coming_soon' where feature_key = 'test_future'`;
      const a3 = await tx`select * from public.salon_feature_access(${p.salonId}, 'test_future')`;
      expect(a3[0]).toEqual({ allowed: false, reason: "lifecycle_coming_soon" });
      await tx`update public.feature_catalog set lifecycle = 'ended' where feature_key = 'test_future'`;
      const a4 = await tx`select * from public.salon_feature_access(${p.salonId}, 'test_future')`;
      expect(a4[0]).toEqual({ allowed: false, reason: "lifecycle_ended" });
      throw new Error("rollback");
    }).catch((e) => {
      if ((e as Error).message !== "rollback") throw e;
    });
  });
});

describe("管理画面の保存", () => {
  it("管理者ではない(未登録・取り消し済み)ユーザーは保存できない", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const owner = p.userId;
    const r1 = await adminSave(sql, { actor: owner, salonId: p.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: { blog: "inherit" } }, changes: { overrides: { blog: "deny" } } });
    expect(r1.result).toBe("not_operator");
    const revoked = await createOperator(sql);
    await sql`update public.operator_admins set revoked_at = now(), revoked_by = 'test' where user_id = ${revoked}`;
    const r2 = await adminSave(sql, { actor: revoked, salonId: p.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: { blog: "inherit" } }, changes: { overrides: { blog: "deny" } } });
    expect(r2.result).toBe("not_operator");
    expect(await overrideMode(p.salonId, "blog")).toBe("inherit");
  });

  it("保存すると版数が上がり、操作した管理者・メモ付きで履歴が残る", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const res = await save(p.salonId, { overrides: { blog: "deny" } }, "契約の確認済み");
    expect(res.result).toBe("saved");
    expect(res.version).toBe(1);
    const logs = await sql`select actor_kind, actor_user_id, target, before, after, note from public.operator_audit_log where salon_id = ${p.salonId}`;
    expect(logs).toEqual([
      { actor_kind: "operator", actor_user_id: operator, target: "feature:blog", before: "inherit", after: "deny", note: "契約の確認済み" },
    ]);
  });

  it("古い版数・古い値からの保存は conflict(何も書かない)", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const stale = await adminSave(sql, { actor: operator, salonId: p.salonId, expectedVersion: 5, expected: { plan: "salonpack", overrides: { blog: "inherit" } }, changes: { overrides: { blog: "deny" } } });
    expect(stale.result).toBe("conflict");
    const wrongValue = await adminSave(sql, { actor: operator, salonId: p.salonId, expectedVersion: 0, expected: { plan: "reviews", overrides: { blog: "inherit" } }, changes: { overrides: { blog: "deny" } } });
    expect(wrongValue.result).toBe("conflict");
    expect(await overrideMode(p.salonId, "blog")).toBe("inherit");
    expect((await stateOf(sql, p.salonId)).version).toBe(0);
  });

  it("CLI・SQL Editor で契約を変えると版数が上がり、開いたままの画面からの保存は conflict になる", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    // 画面を開いた時点: 版数 0・salonpack
    await sql.begin(async (tx) => {
      await tx`select set_config('salonpack.actor_label', 'cli:test-operator', true), set_config('salonpack.change_note', '契約の変更', true)`;
      await tx`update public.salons set plan = 'reviews' where id = ${p.salonId}`;
    });
    expect((await stateOf(sql, p.salonId)).version).toBe(1);
    const res = await adminSave(sql, { actor: operator, salonId: p.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: {} }, changes: { plan: "salonpack" } });
    expect(res.result).toBe("conflict");
    const [log] = await sql`select actor_kind, actor_label, before, after, note from public.operator_audit_log where salon_id = ${p.salonId} and target = 'plan'`;
    expect(log).toEqual({ actor_kind: "cli", actor_label: "cli:test-operator", before: "salonpack", after: "reviews", note: "契約の変更" });
    // 0022 からの契約変更の記録も続けて残る
    const [change] = await sql`select old_plan, new_plan from public.salon_plan_changes where salon_id = ${p.salonId}`;
    expect(change).toEqual({ old_plan: "salonpack", new_plan: "reviews" });
  });

  it("比べていない項目・カタログに無い機能・長すぎるメモは受け付けない", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const notCompared = await adminSave(sql, { actor: operator, salonId: p.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: {} }, changes: { overrides: { blog: "deny" } } });
    expect(notCompared.result).toBe("invalid");
    const unknown = await adminSave(sql, { actor: operator, salonId: p.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: { google_reviews: "inherit" } }, changes: { overrides: { google_reviews: "allow" } } });
    expect(unknown.result).toBe("invalid");
    const longNote = await adminSave(sql, { actor: operator, salonId: p.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: { blog: "inherit" } }, changes: { overrides: { blog: "deny" } }, note: "あ".repeat(501) });
    expect(longNote.result).toBe("invalid");
  });

  it("基準行が無い店舗の初回の保存でも動く(行を作ってから比べる)", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await sql`delete from public.salon_entitlement_state where salon_id = ${p.salonId}`;
    const res = await adminSave(sql, { actor: operator, salonId: p.salonId, expectedVersion: 0, expected: { plan: "salonpack", overrides: { blog: "inherit" } }, changes: { overrides: { blog: "deny" } } });
    expect(res.result).toBe("saved");
  });
});

describe("予約通知: 利用不可で権限による停止を開き、再び許可しても自動で再開しない", () => {
  it("利用不可 → 再び許可 → 運営の解除、の順でだけ送信の対象に戻る", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, p.salonId);
    const pollable = async () =>
      (await sql`select salon_id from public.notifications_list_pollable_salons(null) where salon_id = ${p.salonId}`).length === 1;
    expect(await pollable()).toBe(true);

    expect((await save(p.salonId, { overrides: { reservation_notifications: "deny" } })).result).toBe("saved");
    expect(await openHolds(sql, p.salonId)).toEqual(["reservation_notifications"]);
    expect(await openStops(sql, p.salonId)).toEqual(["entitlement"]);
    expect(await pollable()).toBe(false);

    // 再び許可しただけ: 停止は残り、送信の対象に戻らない
    expect((await save(p.salonId, { overrides: { reservation_notifications: "inherit" } })).result).toBe("saved");
    expect(await openHolds(sql, p.salonId)).toEqual(["reservation_notifications"]);
    expect(await pollable()).toBe(false);
    await addDelivery(sql, p.salonId, lineConnectionId);
    expect(await claim(sql, p.salonId)).toBeNull();
    const [activate] = await sql`select public.reservation_ops_activate(${p.salonId}, 'test', null, null) as r`;
    expect(activate.r).toBe("entitlement_hold");

    // 運営の解除
    const [hold] = await sql<{ id: string }[]>`select id from public.salon_feature_holds where salon_id = ${p.salonId} and released_at is null`;
    const [rel] = await sql`select public.feature_hold_release(${operator}, ${p.salonId}, 'reservation_notifications', ${hold.id}, '確認済み', null) as r`;
    expect(rel.r).toBe("released");
    expect(await openHolds(sql, p.salonId)).toEqual([]);
    expect(await openStops(sql, p.salonId)).toEqual([]);
    expect(await pollable()).toBe(true);
    const logs = await sql`select target, after from public.operator_audit_log where salon_id = ${p.salonId} and target like 'hold:%' order by id`;
    expect(logs).toEqual([
      { target: "hold:reservation_notifications", after: "open" },
      { target: "hold:reservation_notifications", after: "released" },
    ]);
  });

  it("利用不可のままでは解除できない。管理者以外は解除できない", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, p.salonId);
    await save(p.salonId, { overrides: { reservation_notifications: "deny" } });
    const [r1] = await sql`select public.feature_hold_release(${operator}, ${p.salonId}, 'reservation_notifications', null, null, null) as r`;
    expect(r1.r).toBe("not_entitled");
    await save(p.salonId, { overrides: { reservation_notifications: "inherit" } });
    const [r2] = await sql`select public.feature_hold_release(${p.userId}, ${p.salonId}, 'reservation_notifications', null, null, null) as r`;
    expect(r2.r).toBe("not_operator");
    const [r3] = await sql`select public.feature_hold_release(${operator}, ${p.salonId}, 'reservation_notifications', ${"00000000-0000-0000-0000-000000000000"}, null, null) as r`;
    expect(r3.r).toBe("conflict");
    expect(await openHolds(sql, p.salonId)).toEqual(["reservation_notifications"]);
  });

  it("解除しても、受信OFF・利用停止・運営による停止はそのまま", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, p.salonId);
    await sql`insert into public.notification_settings (salon_id, master_enabled) values (${p.salonId}, false)`;
    await sql`update public.salon_feature_selections set selected = false where salon_id = ${p.salonId} and feature_key = 'reservation_notifications'`;
    await sql`select public.reservation_ops_pause(${p.salonId}, 'test', 'テスト停止', 'operator_pause')`;
    await save(p.salonId, { overrides: { reservation_notifications: "deny" } });
    await save(p.salonId, { overrides: { reservation_notifications: "inherit" } });
    await sql`select public.feature_hold_release(${operator}, ${p.salonId}, 'reservation_notifications', null, null, null)`;
    const [ops] = await sql`select state from public.reservation_notification_operations where salon_id = ${p.salonId}`;
    expect(ops.state).toBe("paused");
    const [ns] = await sql`select master_enabled from public.notification_settings where salon_id = ${p.salonId}`;
    expect(ns.master_enabled).toBe(false);
    const [sel] = await sql`select selected from public.salon_feature_selections where salon_id = ${p.salonId} and feature_key = 'reservation_notifications'`;
    expect(sel.selected).toBe(false);
    expect(await openStops(sql, p.salonId)).toEqual(["manual_feature_off", "manual_master_off", "operator_pause"]);
  });

  it("CLI で契約を salonpack から外して戻しても、自動では再開しない", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, p.salonId);
    await sql`update public.salons set plan = 'reviews' where id = ${p.salonId}`;
    await sql`update public.salons set plan = 'salonpack' where id = ${p.salonId}`;
    expect(await openHolds(sql, p.salonId)).toEqual(["reservation_notifications"]);
    // 0022 の contract の停止期間は、もう開閉しない
    expect(await openStops(sql, p.salonId)).toEqual(["entitlement"]);
  });

  it("開始前(setup_pending)の店舗には停止を開かない(開始はもともと明示的な操作)", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await sql`insert into public.reservation_notification_operations (salon_id) values (${p.salonId})`;
    await save(p.salonId, { overrides: { reservation_notifications: "deny" } });
    expect(await openHolds(sql, p.salonId)).toEqual([]);
    const [start] = await sql`select public.reservation_ops_customer_start(${p.salonId}, ${p.userId}, null) as r`;
    expect(start.r).toBe("plan_not_allowed");
  });

  it("停止期間中に届いた予約は解除後も送らない。停止前に届いた未送信の予約は、既存の規則(24時間以内)で送る", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, p.salonId);
    const before = await addDelivery(sql, p.salonId, lineConnectionId, { receivedAt: new Date(Date.now() - 60_000) });
    await save(p.salonId, { overrides: { reservation_notifications: "deny" } });
    const during = await addDelivery(sql, p.salonId, lineConnectionId, { receivedAt: new Date() });
    await save(p.salonId, { overrides: { reservation_notifications: "inherit" } });
    await sql`select public.feature_hold_release(${operator}, ${p.salonId}, 'reservation_notifications', null, null, null)`;
    const results: Record<string, { decision: string; reason: string | null }> = {};
    for (let i = 0; i < 2; i++) {
      const c = await claim(sql, p.salonId);
      expect(c).not.toBeNull();
      results[c!.id] = await beginSend(sql, c!);
    }
    expect(results[before]).toEqual({ decision: "send", reason: null });
    expect(results[during]).toEqual({ decision: "skipped", reason: "received_while_stopped:entitlement" });
  });
});

describe("コミット直前の評価(途中の状態で開閉しない・再帰や重複をしない)", () => {
  it("1つのトランザクションで利用不可にして戻すと、停止も履歴の停止も作らない", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, p.salonId);
    await sql.begin(async (tx) => {
      await tx`update public.salons set plan = 'reviews' where id = ${p.salonId}`;
      await tx`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${p.salonId}, 'blog', 'deny')`;
      await tx`update public.salons set plan = 'salonpack' where id = ${p.salonId}`;
    });
    expect(await openHolds(sql, p.salonId)).toEqual([]);
    expect(await openStops(sql, p.salonId)).toEqual([]);
    const st = await stateOf(sql, p.salonId);
    expect(st.version).toBe(3);
    expect(st.committed).toEqual({ reviews: true, blog: false, reservation_notifications: true });
  });

  it("同じトランザクションで何度変えても、停止は1件・停止期間は1件・履歴の停止は1件", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, p.salonId);
    await sql.begin(async (tx) => {
      await tx`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${p.salonId}, 'reservation_notifications', 'deny')`;
      await tx`update public.salons set plan = 'reviews' where id = ${p.salonId}`;
      await tx`update public.salon_feature_overrides set mode = 'allow' where salon_id = ${p.salonId}`;
      await tx`update public.salons set plan = 'salonpack' where id = ${p.salonId}`;
      await tx`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${p.salonId}`;
    });
    const holds = await sql`select count(*)::int as n from public.salon_feature_holds where salon_id = ${p.salonId}`;
    expect(holds[0].n).toBe(1);
    const stops = await sql`select count(*)::int as n from public.reservation_stop_intervals where salon_id = ${p.salonId} and kind = 'entitlement'`;
    expect(stops[0].n).toBe(1);
    const logs = await sql`select count(*)::int as n from public.operator_audit_log where salon_id = ${p.salonId} and target like 'hold:%'`;
    expect(logs[0].n).toBe(1);
    // 評価が committed_entitled を書いても版数は変わらない(再び起動しない)
    expect((await stateOf(sql, p.salonId)).version).toBe(5);
  });

  it("全体の提供状態の変更も、各店舗の版数・利用可否・停止にそろう(戻しても自動で再開しない)", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, p.salonId);
    const v0 = (await stateOf(sql, p.salonId)).version;
    await sql`update public.feature_catalog set lifecycle = 'ended' where feature_key = 'reservation_notifications'`;
    try {
      const st = await stateOf(sql, p.salonId);
      expect(st.version).toBe(v0 + 1);
      expect(st.committed.reservation_notifications).toBe(false);
      expect(await openHolds(sql, p.salonId)).toEqual(["reservation_notifications"]);
    } finally {
      await sql`update public.feature_catalog set lifecycle = 'available' where feature_key = 'reservation_notifications'`;
    }
    expect(await openHolds(sql, p.salonId)).toEqual(["reservation_notifications"]);
    const [log] = await sql`select actor_kind, target from public.operator_audit_log where salon_id = ${p.salonId} and target like 'catalog:%' order by id limit 1`;
    expect(log).toEqual({ actor_kind: "sql", target: "catalog:reservation_notifications" });
  });

  it("プランの標準の変更も、そのプランの店舗だけ版数を上げる", async () => {
    const r = await createSalon(sql, { plan: "reviews" });
    const p = await createSalon(sql, { plan: "salonpack" });
    const vr = (await stateOf(sql, r.salonId)).version;
    const vp = (await stateOf(sql, p.salonId)).version;
    await sql.begin(async (tx) => {
      await tx`update public.plan_feature_rules set default_enabled = false where plan = 'salonpack' and feature_key = 'blog'`;
      throw new Error("rollback");
    }).catch(() => {});
    await sql`update public.plan_feature_rules set default_enabled = false where plan = 'salonpack' and feature_key = 'blog'`;
    await sql`update public.plan_feature_rules set default_enabled = true where plan = 'salonpack' and feature_key = 'blog'`;
    expect((await stateOf(sql, r.salonId)).version).toBe(vr);
    expect((await stateOf(sql, p.salonId)).version).toBe(vp + 2);
  });
});

describe("旧アプリとの互換(p_allowed_plans を渡す呼び出し)", () => {
  it("個別設定が無ければ、配列を渡しても null でも結果は同じ", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, p.salonId);
    const a = await sql`select salon_id from public.notifications_list_pollable_salons(${["salonpack"]}) where salon_id = ${p.salonId}`;
    const b = await sql`select salon_id from public.notifications_list_pollable_salons(null) where salon_id = ${p.salonId}`;
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    await addDelivery(sql, p.salonId, lineConnectionId);
    const c = await claim(sql, p.salonId, ["salonpack"]);
    expect(await beginSend(sql, c!, ["salonpack"])).toEqual({ decision: "send", reason: null });
  });

  it("旧アプリが渡す対象プランの外は、従来どおり止まる(AND)", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    const { lineConnectionId } = await makeReservationActive(sql, p.salonId);
    await addDelivery(sql, p.salonId, lineConnectionId);
    expect(await claim(sql, p.salonId, ["reviews"])).toBeNull();
  });
});

describe("操作履歴は追記のみ", () => {
  it("UPDATE・DELETE・TRUNCATE を拒否する", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await save(p.salonId, { overrides: { blog: "deny" } });
    await expect(sql`update public.operator_audit_log set note = 'x' where salon_id = ${p.salonId}`).rejects.toThrow(/追記のみ/);
    await expect(sql`delete from public.operator_audit_log where salon_id = ${p.salonId}`).rejects.toThrow(/追記のみ/);
    await expect(sql`truncate public.operator_audit_log`).rejects.toThrow(/追記のみ/);
  });
});

describe("一覧(検索・絞り込み・ページ送り)", () => {
  it("店舗名・登録メールで検索でき、% などは文字として扱う", async () => {
    const a = await createSalon(sql, { plan: "salonpack", name: "検索テスト 100%サロン", email: "find-me@example.test" });
    await createSalon(sql, { plan: "salonpack", name: "検索テスト 別の店" });
    const byName = await sql`select id from public.admin_list_salons('100%', null, null, null, null, null, 50)`;
    expect(byName.map((r) => r.id)).toEqual([a.salonId]);
    const byEmail = await sql`select id, owner_email from public.admin_list_salons('FIND-ME', null, null, null, null, null, 50)`;
    expect(byEmail).toEqual([{ id: a.salonId, owner_email: "find-me@example.test" }]);
  });

  it("プラン・機能の最終的な利用可否で絞り込み、続きから読める", async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) created.push((await createSalon(sql, { plan: "salonpack", name: `ページ送り ${i}` })).salonId);
    await save(created[1], { overrides: { blog: "deny" } });
    const denied = await sql`select id from public.admin_list_salons('ページ送り', 'salonpack', 'blog', false, null, null, 50)`;
    expect(denied.map((r) => r.id)).toEqual([created[1]]);
    const page1 = await sql<{ id: string; created_at: Date }[]>`select id, created_at from public.admin_list_salons('ページ送り', null, null, null, null, null, 2)`;
    expect(page1.length).toBe(2);
    const last = page1[1];
    const page2 = await sql<{ id: string }[]>`select id from public.admin_list_salons('ページ送り', null, null, null, ${last.created_at}, ${last.id}, 2)`;
    expect([...page1.map((r) => r.id), ...page2.map((r) => r.id)].sort()).toEqual([...created].sort());
  });
});

describe("口コミプランのまま他の機能を個別に許可できない", () => {
  it("対象プランの外への許可・利用不可は保存できない。プランに従うへ戻すことはできる", async () => {
    const r = await createSalon(sql, { plan: "reviews" });
    const res = await save(r.salonId, { overrides: { blog: "allow" } });
    expect(res).toMatchObject({ result: "invalid" });
    // SalonPack から口コミプランに変えると、残った個別設定は効かない(履歴・値は残る)
    const p = await createSalon(sql, { plan: "salonpack" });
    expect((await save(p.salonId, { overrides: { blog: "allow" } })).result).toBe("saved");
    expect((await save(p.salonId, { plan: "reviews" })).result).toBe("saved");
    expect(await access(p.salonId, "blog")).toEqual({ allowed: false, reason: "not_in_plan" });
    expect(await overrideMode(p.salonId, "blog")).toBe("allow");
    expect((await save(p.salonId, { overrides: { blog: "inherit" } })).result).toBe("saved");
    // 同じ保存でプランを SalonPack に変えるなら、許可できる
    const r2 = await createSalon(sql, { plan: "reviews" });
    expect((await save(r2.salonId, { plan: "salonpack", overrides: { blog: "deny" } })).result).toBe("saved");
  });
});

describe("操作履歴の読み出し", () => {
  it("新しい順に、管理者のメールアドレスを添えて返す", async () => {
    const p = await createSalon(sql, { plan: "salonpack" });
    await save(p.salonId, { overrides: { blog: "deny" } }, "1回目");
    await save(p.salonId, { overrides: { blog: "inherit" } }, "2回目");
    const rows = await sql<{ id: string; note: string; actor_email: string }[]>`select id, note, actor_email from public.admin_audit_log(${p.salonId}, null, 1)`;
    expect(rows.map((r) => r.note)).toEqual(["2回目"]);
    expect(rows[0].actor_email).toMatch(/^ops-/);
    const older = await sql<{ note: string }[]>`select note from public.admin_audit_log(${p.salonId}, ${rows[0].id}, 10)`;
    expect(older.map((r) => r.note)).toEqual(["1回目"]);
  });
});

describe("アプリ側の写し・予測が DB と一致する", () => {
  it("機能カタログの機能は registry に定義があり、registry の catalog の機能はすべてカタログにある", async () => {
    const { FEATURE_REGISTRY } = await import("@/lib/features/registry");
    const rows = await sql<{ feature_key: string }[]>`select feature_key from public.feature_catalog order by feature_key`;
    const catalogKeys = FEATURE_REGISTRY.filter((d) => d.entitlement === "catalog").map((d) => d.key).sort();
    expect(rows.map((r) => r.feature_key)).toEqual(catalogKeys);
  });

  it("単体テスト用の初期値の写しが、DB の初期値と同じ", async () => {
    const { CATALOG_SEED, PLAN_RULES_SEED } = await import("../../__tests__/helpers/entitlements");
    const catalog = await sql<{ feature_key: string; lifecycle: string; has_runtime: boolean }[]>`select * from public.feature_catalog`;
    expect(Object.fromEntries(catalog.map((c) => [c.feature_key, { lifecycle: c.lifecycle, hasRuntime: c.has_runtime }]))).toEqual(CATALOG_SEED);
    const rules = await sql<{ plan: "reviews" | "salonpack"; feature_key: string; default_enabled: boolean }[]>`select plan, feature_key, default_enabled from public.plan_feature_rules`;
    const byPlan: Record<string, Record<string, boolean>> = { reviews: {}, salonpack: {} };
    for (const r of rules) byPlan[r.plan][r.feature_key] = r.default_enabled;
    expect(byPlan).toEqual(PLAN_RULES_SEED);
  });

  it("確認ダイアログの予測(previewAccess)が、プラン × 個別設定 × 提供状態 × 標準のすべてで DB と同じ", async () => {
    const { previewAccess } = await import("@/lib/ops/preview");
    await sql
      .begin(async (tx) => {
        await tx`insert into public.feature_catalog (feature_key, lifecycle) values ('test_matrix', 'available')`;
        await tx`insert into public.plan_feature_rules (plan, feature_key, default_enabled) values ('salonpack', 'test_matrix', true)`;
        const salons: Record<string, string> = {};
        for (const plan of ["reviews", "salonpack"] as const) salons[plan] = (await createSalon(tx as unknown as Sql, { plan })).salonId;
        let checked = 0;
        for (const lifecycle of ["available", "coming_soon", "ended"] as const) {
          await tx`update public.feature_catalog set lifecycle = ${lifecycle} where feature_key = 'test_matrix'`;
          for (const defaultEnabled of [true, false]) {
            await tx`update public.plan_feature_rules set default_enabled = ${defaultEnabled} where feature_key = 'test_matrix'`;
            for (const plan of ["reviews", "salonpack"] as const) {
              for (const mode of ["inherit", "allow", "deny"] as const) {
                await tx`delete from public.salon_feature_overrides where salon_id = ${salons[plan]} and feature_key = 'test_matrix'`;
                if (mode !== "inherit") {
                  await tx`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${salons[plan]}, 'test_matrix', ${mode})`;
                }
                const [db] = await tx<{ allowed: boolean; reason: string }[]>`select * from public.salon_feature_access(${salons[plan]}, 'test_matrix')`;
                const rules = { reviews: {}, salonpack: { test_matrix: defaultEnabled } };
                expect({ lifecycle, defaultEnabled, plan, mode, ...previewAccess({ lifecycle, hasRuntime: false }, rules, plan, "test_matrix", mode) }).toEqual({
                  lifecycle, defaultEnabled, plan, mode, allowed: db.allowed, reason: db.reason,
                });
                checked++;
              }
            }
          }
        }
        expect(checked).toBe(36);
        throw new Error("rollback");
      })
      .catch((e) => {
        if ((e as Error).message !== "rollback") throw e;
      });
  });
});
