// 0026(運営の承認をなくした登録の流れ)を、ローカルの PostgreSQL で確かめる。
//   - 新規登録の受付(self_signup_settings): 閉じている間は、お客様が自分で店舗を登録できない。運営の登録は止めない
//   - 新しい店舗は無料提供にできない(0025 の時点の店舗だけ)。プランが仮の値の店舗はテスト用にできない
//   - 登録しただけでは使えない(利用開始待ち)。お客様は区分・プラン・仮の値かどうかを変えられない
//   - 送信の間隔(auth_email_cooldown_take): 前回から N 秒。同時でも送ってよいのは1つ。ブラウザのロールからは使えない
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { createOperator, createSalon, createSession, makeReservationActive, openHolds, openStops } from "./fixtures";

const DB = "salonpack_localdb_onboarding0026";
let sql: Sql;
let operator: string;

beforeAll(async () => {
  sql = await createDatabase(DB);
  operator = await createOperator(sql);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

type Result = { result: string; [k: string]: unknown };

async function setSignupOpen(open: boolean) {
  await sql`update public.self_signup_settings set open = ${open} where id = 1`;
}

/** ロールと request.jwt.claims を設定したトランザクションで fn を実行する。commit = false なら最後に取り消す。 */
async function as<T>(role: "anon" | "authenticated", claims: string | null, fn: (tx: TransactionSql) => Promise<T>, commit = false): Promise<T> {
  let result: T;
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      if (claims) {
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx`select set_config('request.jwt.claim.sub', ${JSON.parse(claims).sub as string}, true)`;
      }
      result = await fn(tx);
      if (!commit) throw new Error("__rollback__");
    })
    .catch((e) => {
      if ((e as Error).message !== "__rollback__") throw e;
    });
  return result!;
}

async function fails(role: "anon" | "authenticated", claims: string | null, fn: (tx: TransactionSql) => Promise<unknown>): Promise<boolean> {
  let failed = false;
  await as(role, claims, async (tx) => {
    try {
      await tx.savepoint(async (sp) => {
        await fn(sp as unknown as TransactionSql);
      });
    } catch {
      failed = true;
    }
  });
  return failed;
}

/** メールのリンクで得て本人確認を済ませたセッション(信頼できるセッション)。 */
async function trustedUser(): Promise<{ userId: string; claims: string }> {
  const userId = randomUUID();
  await sql`insert into auth.users (id, email, email_confirmed_at) values (${userId}, ${`u-${userId.slice(0, 8)}@example.test`}, now())`;
  const session = await createSession(sql, userId, { amr: ["otp"] });
  const [r] = await sql<{ r: string }[]>`select public.account_verification_record(${userId}, ${session.sessionId}, 'password_set') as r`;
  expect(r.r).toBe("recorded");
  return { userId, claims: session.claims };
}

async function createOwn(claims: string): Promise<Result> {
  return as(
    "authenticated",
    claims,
    async (tx) => {
      const [row] = await tx<{ r: Result }[]>`
        select public.create_own_salon('私のサロン', '山田 花子', null, null, null, ${`o-${randomUUID().slice(0, 12)}`}) as r`;
      return row.r;
    },
    true,
  );
}

async function saveDraft(fields: Record<string, unknown>): Promise<Result> {
  const [row] = await sql<{ r: Result }[]>`select public.admin_save_salon_draft(${operator}, null, null, ${sql.json(fields as never)}) as r`;
  return row.r;
}

async function register(draftId: string, ownerUserId: string): Promise<Result> {
  const [row] = await sql<{ r: Result }[]>`
    select public.admin_register_salon(${operator}, ${draftId}, 0, ${ownerUserId}, ${`r-${randomUUID().slice(0, 12)}`}, ${randomUUID()}) as r`;
  return row.r;
}

/** アプリが新しいアドレスで用意するアカウント(未確認・パスワード無し・set_new)。 */
async function invitedAccount(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `inv-${id.slice(0, 8)}@example.test`;
  await sql`insert into auth.users (id, email) values (${id}, ${email})`;
  await sql`select public.account_requirement_set(${id}, 'set_new', 'operator_invite', false)`;
  return { id, email };
}

function draft(email: string, extra: Record<string, unknown> = {}) {
  return { name: "運営が登録するサロン", contact_name: "担当 太郎", login_email: email, service_status: "pending", ...extra };
}

async function version(salonId: string): Promise<number> {
  const [row] = await sql`select version from public.salon_entitlement_state where salon_id = ${salonId}`;
  return Number(row?.version ?? 0);
}

async function changeStatus(salonId: string, expected: string, next: string): Promise<Result> {
  const [row] = await sql<{ r: Result }[]>`
    select public.admin_update_salon_service_status(${operator}, ${salonId}, ${await version(salonId)}, ${expected}, ${next}, null, ${randomUUID()}) as r`;
  return row.r;
}

async function accessOf(salonId: string, feature: string) {
  const [row] = await sql<{ allowed: boolean; reason: string }[]>`select allowed, reason from public.salon_feature_access(${salonId}, ${feature})`;
  return row;
}

describe("新規登録の受付(お客様が自分で店舗を登録する)", () => {
  it("閉じている間は作らない(信頼できるセッションでも)。開くと、利用開始待ち・プラン未定で作る", async () => {
    const user = await trustedUser();
    expect((await createOwn(user.claims)).result).toBe("closed");
    const [{ n }] = await sql`select count(*)::int as n from public.salons s join public.profiles p on p.id = s.owner_id where p.user_id = ${user.userId}`;
    expect(n).toBe(0);

    await setSignupOpen(true);
    const created = await createOwn(user.claims);
    expect(created.result).toBe("created");
    const [s] = await sql`select plan_placeholder, service_status, registration_source from public.salons where id = ${created.salon_id as string}`;
    expect(s).toEqual({ plan_placeholder: true, service_status: "pending", registration_source: "self_signup" });
    expect(await accessOf(created.salon_id as string, "reviews")).toEqual({ allowed: false, reason: "service_pending" });
    const [log] = await sql`select after from public.operator_audit_log where salon_id = ${created.salon_id as string} and target = 'registration'`;
    expect(log.after).toEqual({ source: "self_signup", plan: null, plan_placeholder: true, service_status: "pending" });
    await setSignupOpen(false);
  });

  it("受付が閉じていても、運営の登録(本登録)は止めない", async () => {
    const account = await invitedAccount();
    const d = await saveDraft(draft(account.email, { plan: "salonpack" }));
    expect((await register(d.draft_id as string, account.id)).result).toBe("registered");
  });

  it("受付の設定は、ブラウザのロールから読めず変えられない", async () => {
    const user = await trustedUser();
    expect(await fails("authenticated", user.claims, (tx) => tx`select open from public.self_signup_settings`)).toBe(true);
    expect(await fails("authenticated", user.claims, (tx) => tx`update public.self_signup_settings set open = true`)).toBe(true);
    expect(await fails("anon", null, (tx) => tx`select open from public.self_signup_settings`)).toBe(true);
    const [s] = await sql`select open from public.self_signup_settings where id = 1`;
    expect(s.open).toBe(false);
  });
});

describe("運営の本登録(登録種別とプラン)", () => {
  it("新しい店舗は無料提供にできない(下書きの保存でも本登録でも)", async () => {
    const account = await invitedAccount();
    expect((await saveDraft(draft(account.email, { plan: "salonpack", service_status: "complimentary" }))).result).toBe("invalid:service_status");
    // 0025 のときに保存された「無料提供」の下書きは、本登録できない
    const d = await saveDraft(draft(account.email, { plan: "salonpack" }));
    await sql`update public.salon_drafts set service_status = 'complimentary' where id = ${d.draft_id as string}`;
    expect((await register(d.draft_id as string, account.id)).result).toBe("invalid:service_status");
  });

  it("通常登録はプランが任意(無ければ仮の値)。案内予定のプランを指定しても、使えない", async () => {
    const a = await invitedAccount();
    const noPlan = await register((await saveDraft(draft(a.email))).draft_id as string, a.id);
    expect(noPlan.result).toBe("registered");
    const [s1] = await sql`select plan_placeholder, service_status from public.salons where id = ${noPlan.salon_id as string}`;
    expect(s1).toEqual({ plan_placeholder: true, service_status: "pending" });
    const [log] = await sql`select after from public.operator_audit_log where salon_id = ${noPlan.salon_id as string} and target = 'registration'`;
    expect(log.after).toMatchObject({ source: "operator", plan: null, plan_placeholder: true, service_status: "pending" });

    const b = await invitedAccount();
    const planned = await register((await saveDraft(draft(b.email, { plan: "salonpack" }))).draft_id as string, b.id);
    const [s2] = await sql`select plan, plan_placeholder from public.salons where id = ${planned.salon_id as string}`;
    expect(s2).toEqual({ plan: "salonpack", plan_placeholder: false });
    for (const f of ["reviews", "blog", "reservation_notifications"]) {
      expect((await accessOf(planned.salon_id as string, f)).allowed).toBe(false);
    }
  });

  it("プランが無いときは、機能ごとの利用許可を登録しない。テスト用はプランが必須", async () => {
    const a = await invitedAccount();
    const withOverrides = await saveDraft(draft(a.email, { feature_overrides: { blog: "deny" } }));
    expect((await register(withOverrides.draft_id as string, a.id)).result).toBe("invalid:feature_overrides");
    const b = await invitedAccount();
    const testNoPlan = await saveDraft(draft(b.email, { service_status: "test" }));
    expect((await register(testNoPlan.draft_id as string, b.id)).result).toBe("incomplete:plan");
    const c = await invitedAccount();
    const testWithPlan = await register((await saveDraft(draft(c.email, { service_status: "test", plan: "reviews" }))).draft_id as string, c.id);
    expect(testWithPlan.result).toBe("registered");
    const [s] = await sql`select plan, plan_placeholder, service_status from public.salons where id = ${testWithPlan.salon_id as string}`;
    expect(s).toEqual({ plan: "reviews", plan_placeholder: false, service_status: "test" });
    expect((await accessOf(testWithPlan.salon_id as string, "reviews")).allowed).toBe(true);
  });
});

describe("利用区分の変更(運営)", () => {
  it("新しい店舗は無料提供にできない(利用開始待ちからも、テスト用からも)", async () => {
    const pending = await createSalon(sql, { serviceStatus: "pending", registrationSource: "operator" });
    expect(await changeStatus(pending.salonId, "pending", "complimentary")).toMatchObject({ result: "invalid", detail: "complimentary_existing_only" });
    const test = await createSalon(sql, { serviceStatus: "test", registrationSource: "self_signup" });
    expect(await changeStatus(test.salonId, "test", "complimentary")).toMatchObject({ result: "invalid", detail: "complimentary_existing_only" });
    const [s] = await sql`select service_status from public.salons where id = ${pending.salonId}`;
    expect(s.service_status).toBe("pending");
  });

  it("プランが仮の値の店舗はテスト用にできない(DB の制約でも、仮の値のまま利用中にならない)", async () => {
    const s = await createSalon(sql, { plan: "reviews", serviceStatus: "pending", registrationSource: "self_signup", planPlaceholder: true });
    expect(await changeStatus(s.salonId, "pending", "test")).toMatchObject({ result: "invalid", detail: "plan_required" });
    await expect(sql`update public.salons set service_status = 'test' where id = ${s.salonId}`).rejects.toThrow(/salons_plan_placeholder_check/);
  });

  it("案内予定のプランのある店舗をテスト用にすると使える。そのときの契約プランを履歴に残す", async () => {
    const s = await createSalon(sql, { plan: "salonpack", serviceStatus: "pending", registrationSource: "operator" });
    expect((await accessOf(s.salonId, "reviews")).allowed).toBe(false);
    expect((await changeStatus(s.salonId, "pending", "test")).result).toBe("saved");
    expect((await accessOf(s.salonId, "reviews")).allowed).toBe(true);
    const [log] = await sql`select actor_kind, actor_user_id, after from public.operator_audit_log where salon_id = ${s.salonId} and target = 'contract_plan'`;
    expect(log).toEqual({ actor_kind: "operator", actor_user_id: operator, after: { plan: "salonpack", service_status: "test" } });
    // 止めて(利用開始待ち)、またテスト用にできる。新しい店舗なので無料提供には戻せない
    expect((await changeStatus(s.salonId, "test", "pending")).result).toBe("saved");
    expect(await changeStatus(s.salonId, "pending", "complimentary")).toMatchObject({ detail: "complimentary_existing_only" });
    expect((await changeStatus(s.salonId, "pending", "test")).result).toBe("saved");
  });

  it("既存の店舗は、止めたあと無料提供に戻せる。テスト用との行き来もできる", async () => {
    const s = await createSalon(sql, { plan: "reviews" });
    expect((await changeStatus(s.salonId, "complimentary", "pending")).result).toBe("saved");
    expect((await accessOf(s.salonId, "reviews")).allowed).toBe(false);
    expect((await changeStatus(s.salonId, "pending", "complimentary")).result).toBe("saved");
    expect((await accessOf(s.salonId, "reviews")).allowed).toBe(true);
    expect((await changeStatus(s.salonId, "complimentary", "test")).result).toBe("saved");
    expect((await changeStatus(s.salonId, "test", "complimentary")).result).toBe("saved");
    const [row] = await sql`select plan, service_status from public.salons where id = ${s.salonId}`;
    expect(row).toEqual({ plan: "reviews", service_status: "complimentary" });
  });
});

describe("止めている既存の店舗の契約プラン・利用許可の調整(運営)", () => {
  it("保存しても、利用区分は利用開始待ちのまま・権限による停止は開いたまま・予約通知の停止も続く。区分を戻しても停止は解除しない", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    await makeReservationActive(sql, s.salonId);
    expect((await changeStatus(s.salonId, "complimentary", "pending")).result).toBe("saved");
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
    const stopsBefore = await openStops(sql, s.salonId);
    const opsBefore = await sql`select state from public.reservation_notification_operations where salon_id = ${s.salonId}`;

    // 運営の画面と同じ保存(0024 の admin_update_salon_entitlements)。プランと個別設定を変える
    const save = async (expected: Record<string, unknown>, changes: Record<string, unknown>) =>
      (
        await sql<{ r: Result }[]>`
          select public.admin_update_salon_entitlements(${operator}, ${s.salonId}, ${await version(s.salonId)},
            ${sql.json(expected as never)}, ${sql.json(changes as never)}, '停止中の調整', ${randomUUID()}) as r`
      )[0].r;
    expect((await save({ plan: "salonpack", overrides: { blog: "inherit" } }, { overrides: { blog: "deny" } })).result).toBe("saved");
    expect((await save({ plan: "salonpack" }, { plan: "reviews" })).result).toBe("saved");

    const [row] = await sql`select plan, service_status from public.salons where id = ${s.salonId}`;
    expect(row).toEqual({ plan: "reviews", service_status: "pending" });
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
    expect(await openStops(sql, s.salonId)).toEqual(stopsBefore);
    expect(await sql`select state from public.reservation_notification_operations where salon_id = ${s.salonId}`).toEqual(opsBefore);
    expect((await accessOf(s.salonId, "reviews")).allowed).toBe(false);

    // 区分を戻すと、契約プランの機能は使える。予約通知の権限による停止は、明示的に解除するまで開いたまま
    expect((await changeStatus(s.salonId, "pending", "complimentary")).result).toBe("saved");
    expect((await accessOf(s.salonId, "reviews")).allowed).toBe(true);
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
  });
});

describe("お客様(ブラウザのロール)が制限を回避できない", () => {
  it("利用区分・プラン・仮の値かどうか・登録経路は、利用開始待ちでも利用中でも変えられない", async () => {
    await setSignupOpen(true);
    const user = await trustedUser();
    const created = await createOwn(user.claims);
    await setSignupOpen(false);
    const pendingId = created.salon_id as string;
    for (const set of ["plan_placeholder = false", "service_status = 'test'", "plan = 'salonpack'", "registration_source = 'existing'"]) {
      expect(await fails("authenticated", user.claims, (tx) => tx.unsafe(`update public.salons set ${set} where id = '${pendingId}'`))).toBe(true);
    }
    // 登録内容(店舗名)は変えられる
    expect(await fails("authenticated", user.claims, (tx) => tx`update public.salons set name = '新しい名前' where id = ${pendingId}`)).toBe(false);
    const [s] = await sql`select plan_placeholder, service_status, registration_source from public.salons where id = ${pendingId}`;
    expect(s).toEqual({ plan_placeholder: true, service_status: "pending", registration_source: "self_signup" });
  });

  it("運営の関数・送信の間隔の関数は、ブラウザのロールから実行できない", async () => {
    const user = await trustedUser();
    const s = await createSalon(sql, { serviceStatus: "pending", registrationSource: "operator" });
    const calls = [
      (tx: TransactionSql) => tx`select public.auth_email_cooldown_take('k', 60)`,
      (tx: TransactionSql) => tx`select public.admin_update_salon_service_status(${operator}, ${s.salonId}, 0, 'pending', 'test', null, null)`,
      (tx: TransactionSql) => tx`select public.admin_register_salon(${operator}, ${randomUUID()}, 0, ${user.userId}, 'x', null)`,
      (tx: TransactionSql) => tx`select * from public.admin_list_salons(null, null, null, null, null, null, 10, null)`,
      (tx: TransactionSql) => tx`select * from public.auth_email_cooldowns`,
    ];
    for (const call of calls) {
      expect(await fails("authenticated", user.claims, call)).toBe(true);
      expect(await fails("anon", null, call)).toBe(true);
    }
  });
});

describe("一覧(契約プランでの絞り込み)", () => {
  it("利用開始待ちの新しい店舗のプランは、契約プランとして絞り込まない。止めている既存の店舗は含める", async () => {
    const planned = await createSalon(sql, { plan: "salonpack", serviceStatus: "pending", registrationSource: "operator", name: "絞り込み 予定" });
    const placeholder = await createSalon(sql, { plan: "salonpack", serviceStatus: "pending", registrationSource: "self_signup", planPlaceholder: true, name: "絞り込み 仮" });
    const stopped = await createSalon(sql, { plan: "salonpack", serviceStatus: "pending", name: "絞り込み 停止" });
    const inUse = await createSalon(sql, { plan: "salonpack", serviceStatus: "test", registrationSource: "operator", name: "絞り込み 利用中" });
    const rows = await sql<{ id: string; plan_placeholder: boolean }[]>`
      select id, plan_placeholder from public.admin_list_salons('絞り込み', 'salonpack', null, null, null, null, 50, null)`;
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([stopped.salonId, inUse.salonId].sort());
    const all = await sql<{ id: string; plan_placeholder: boolean }[]>`
      select id, plan_placeholder from public.admin_list_salons('絞り込み', null, null, null, null, null, 50, null)`;
    expect(new Map(all.map((r) => [r.id, r.plan_placeholder]))).toEqual(
      new Map([
        [planned.salonId, false],
        [placeholder.salonId, true],
        [stopped.salonId, false],
        [inUse.salonId, false],
      ]),
    );
  });
});

describe("送信の間隔(前回から N 秒)", () => {
  it("1回目は 0(記録する)。間隔の中は残りの秒数(記録しない)。間隔が過ぎるとまた 0", async () => {
    const key = `confirm:${randomUUID()}`;
    const take = async () => Number((await sql`select public.auth_email_cooldown_take(${key}, 65) as r`)[0].r);
    expect(await take()).toBe(0);
    const left = await take();
    expect(left).toBeGreaterThanOrEqual(64);
    expect(left).toBeLessThanOrEqual(65);
    await sql`update public.auth_email_cooldowns set last_at = now() - interval '40 seconds' where cooldown_key = ${key}`;
    const later = await take();
    expect(later).toBeGreaterThanOrEqual(24);
    expect(later).toBeLessThanOrEqual(25);
    await sql`update public.auth_email_cooldowns set last_at = now() - interval '66 seconds' where cooldown_key = ${key}`;
    expect(await take()).toBe(0);
  });

  it("同時に呼んでも、送ってよいのは1つだけ", async () => {
    const key = `confirm:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sql.begin(async (tx) => Number((await tx`select public.auth_email_cooldown_take(${key}, 65) as r`)[0].r))),
    );
    expect(results.filter((r) => r === 0).length).toBe(1);
  });

  it("キー・秒数の誤りはエラー", async () => {
    await expect(sql`select public.auth_email_cooldown_take('', 60)`).rejects.toThrow();
    await expect(sql`select public.auth_email_cooldown_take('k', 0)`).rejects.toThrow();
    await expect(sql`select public.auth_email_cooldown_take('k', 4000)`).rejects.toThrow();
  });
});
