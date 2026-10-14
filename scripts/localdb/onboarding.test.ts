// 0025(利用区分・本人確認とセッション・ブラウザからの読み書き)を、ローカルの PostgreSQL で確かめる。
// Supabase Auth の実際の動き(セッション・認証方法の記録・古いトークン)は scripts/testdb/auth-verification.test.ts で確かめる。
// ここでは、DB の関数・RLS が、auth.sessions / auth.mfa_amr_claims の内容に対して正しく判定することを確かめる。
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { createOperator, createSalon, createSession, makeReservationActive, openHolds, type SalonFixture } from "./fixtures";

const DB = "salonpack_localdb_onboarding";
let sql: Sql;

beforeAll(async () => {
  sql = await createDatabase(DB);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

/** PostgREST と同じく、ロールと request.jwt.claims を設定したトランザクションで fn を実行し、最後に必ず取り消す。 */
async function as<T>(role: "anon" | "authenticated", claims: string | null, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T;
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      if (claims) {
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx`select set_config('request.jwt.claim.sub', ${JSON.parse(claims).sub as string}, true)`;
      }
      result = await fn(tx);
      throw new Error("__rollback__");
    })
    .catch((e) => {
      if ((e as Error).message !== "__rollback__") throw e;
    });
  return result!;
}

/** as と同じだが、エラーになったかどうかを返す(コミットしない)。 */
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

/** ブラウザのロールで、コミットまで行う(RPC で作ったものを、あとで確かめるため)。 */
async function commitAs<T>(claims: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local role authenticated");
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`select set_config('request.jwt.claim.sub', ${JSON.parse(claims).sub as string}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function newUser(opts: { confirmed?: boolean; email?: string } = {}): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, email, email_confirmed_at)
            values (${id}, ${opts.email ?? `user-${id.slice(0, 8)}@example.test`}, ${opts.confirmed === false ? null : new Date()})`;
  return id;
}

async function record(userId: string, sessionId: string, method = "password_set"): Promise<string> {
  const [row] = await sql<{ r: string }[]>`select public.account_verification_record(${userId}, ${sessionId}, ${method}) as r`;
  return row.r;
}

async function trusted(claims: string): Promise<boolean> {
  const [row] = await as("authenticated", claims, (tx) => tx<{ t: boolean }[]>`select session_trusted as t from public.my_account_state()`);
  return row.t;
}

async function accessOf(salonId: string, feature: string): Promise<{ allowed: boolean; reason: string }> {
  const [row] = await sql<{ allowed: boolean; reason: string }[]>`select * from public.salon_feature_access(${salonId}, ${feature})`;
  return row;
}

describe("利用区分と利用可否", () => {
  it("新しい店舗の既定は利用開始待ち・お客様による登録", async () => {
    const userId = await newUser();
    const [profile] = await sql<{ id: string }[]>`select id from public.profiles where user_id = ${userId}`;
    const [s] = await sql<{ service_status: string; registration_source: string }[]>`
      insert into public.salons (owner_id, name, slug) values (${profile.id}, '既定の確認', ${`d-${userId.slice(0, 12)}`})
      returning service_status, registration_source`;
    expect(s).toEqual({ service_status: "pending", registration_source: "self_signup" });
  });

  it("利用開始待ちでは、本来なら利用可の機能だけ service_pending。対象外・個別に不可の理由は変えない", async () => {
    const pending = await createSalon(sql, { plan: "reviews", serviceStatus: "pending" });
    expect(await accessOf(pending.salonId, "reviews")).toEqual({ allowed: false, reason: "service_pending" });
    expect(await accessOf(pending.salonId, "blog")).toEqual({ allowed: false, reason: "not_in_plan" });
    for (const status of ["complimentary", "test"] as const) {
      const s = await createSalon(sql, { plan: "reviews", serviceStatus: status });
      expect(await accessOf(s.salonId, "reviews")).toEqual({ allowed: true, reason: "plan_default" });
      expect(await accessOf(s.salonId, "blog")).toEqual({ allowed: false, reason: "not_in_plan" });
    }
  });

  it("利用開始待ちの店舗は、公開ページ・予約通知の対象にならない", async () => {
    const pending = await createSalon(sql, { plan: "salonpack", serviceStatus: "pending" });
    await makeReservationActive(sql, pending.salonId);
    const [pub] = await sql<{ reviews_available: boolean }[]>`select reviews_available from public.salon_public where id = ${pending.salonId}`;
    expect(pub.reviews_available).toBe(false);
    const pollable = await sql`select 1 from public.notifications_list_pollable_salons(null) where salon_id = ${pending.salonId}`;
    expect(pollable.length).toBe(0);
    const [block] = await sql<{ b: string | null }[]>`select public.reservation_entitlement_block(${pending.salonId}, null, false) as b`;
    expect(block.b).toBe("not_entitled");
  });

  it("稼働中の店舗を利用開始待ちにすると権限による停止が開き、利用中に戻しても再開しない", async () => {
    const s = await createSalon(sql, { plan: "salonpack", serviceStatus: "complimentary" });
    await makeReservationActive(sql, s.salonId);
    await sql`update public.salons set service_status = 'pending' where id = ${s.salonId}`;
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
    await sql`update public.salons set service_status = 'complimentary' where id = ${s.salonId}`;
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
    const log = await sql`select target, before, after from public.operator_audit_log where salon_id = ${s.salonId} and target = 'service_status' order by id`;
    expect(log).toEqual([
      { target: "service_status", before: "complimentary", after: "pending" },
      { target: "service_status", before: "pending", after: "complimentary" },
    ]);
  });

  it("LINE の通知先の招待は、利用中の区分でない店舗では unavailable", async () => {
    const s = await createSalon(sql, { plan: "salonpack", serviceStatus: "pending" });
    const [inv] = await sql<{ status: string }[]>`
      with i as (
        insert into public.line_recipient_invites (salon_id, token_hash, display_name, created_by, expires_at)
        values (${s.salonId}, ${(randomUUID() + randomUUID()).replace(/-/g, "")}, 'スタッフ', ${s.userId}, now() + interval '1 day')
        returning *)
      select public.line_invite_status(i) as status from i`;
    expect(inv.status).toBe("unavailable");
  });
});

describe("セッションの信頼(本人確認のあと・本人確認を行ったセッションだけ)", () => {
  it("legacy のアカウントは、auth.sessions に行のあるセッションだけ信頼する(削除・期限切れは即座に拒否)", async () => {
    const s = await createSalon(sql);
    const live = await createSession(sql, s.userId);
    expect(await trusted(live.claims)).toBe(true);
    const expired = await createSession(sql, s.userId, { notAfter: new Date(Date.now() - 1000) });
    expect(await trusted(expired.claims)).toBe(false);
    const signedOut = await createSession(sql, s.userId);
    await sql`delete from auth.sessions where id = ${signedOut.sessionId}`;
    expect(await trusted(signedOut.claims)).toBe(false);
    // JWT に session_id が無い・別人のセッション
    expect(await trusted(JSON.stringify({ sub: s.userId }))).toBe(false);
    const other = await createSalon(sql);
    const otherSession = await createSession(sql, other.userId);
    expect(await trusted(JSON.stringify({ sub: s.userId, session_id: otherSession.sessionId }))).toBe(false);
  });

  it("本人確認より前のセッションは、本人確認のあとも信頼しない。確認したセッションと、あとで作ったセッションは信頼する", async () => {
    const userId = await newUser();
    const thirdParty = await createSession(sql, userId, { amr: ["password"], createdAt: new Date(Date.now() - 60_000) });
    const owner = await createSession(sql, userId, { amr: ["otp"] });
    expect(await trusted(thirdParty.claims)).toBe(false);
    expect(await trusted(owner.claims)).toBe(false);
    expect(await record(userId, owner.sessionId)).toBe("recorded");
    expect(await trusted(owner.claims)).toBe(true);
    expect(await trusted(thirdParty.claims)).toBe(false);
    const later = await createSession(sql, userId, { amr: ["password"], createdAt: new Date(Date.now() + 1000) });
    expect(await trusted(later.claims)).toBe(true);
  });

  it("記録の関数は、メールのリンクのセッション・確認済みのメール・本人のセッションでなければ記録しない", async () => {
    const userId = await newUser();
    const pw = await createSession(sql, userId, { amr: ["password"] });
    expect(await record(userId, pw.sessionId)).toBe("not_email_link");
    const other = await newUser();
    const otherLink = await createSession(sql, other, { amr: ["otp"] });
    expect(await record(userId, otherLink.sessionId)).toBe("not_email_link");
    const unconfirmed = await newUser({ confirmed: false });
    const link = await createSession(sql, unconfirmed, { amr: ["invite"] });
    expect(await record(unconfirmed, link.sessionId)).toBe("email_unconfirmed");
    const expired = await createSession(sql, userId, { amr: ["magiclink"], notAfter: new Date(Date.now() - 1000) });
    expect(await record(userId, expired.sessionId)).toBe("not_email_link");
    expect(await record(userId, pw.sessionId, "legacy")).toBe("invalid");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.account_verifications where user_id = ${userId}`;
    expect(n).toBe(0);
  });

  it("2回目と同時の記録は、最初の1回だけが残る", async () => {
    const userId = await newUser();
    const a = await createSession(sql, userId, { amr: ["recovery"] });
    const b = await createSession(sql, userId, { amr: ["invite"] });
    const results = await Promise.all([record(userId, a.sessionId, "password_set"), record(userId, b.sessionId, "password_confirmed")]);
    expect(results.sort()).toEqual(["already_verified", "recorded"]);
    expect(await record(userId, a.sessionId)).toBe("already_verified");
    const rows = await sql`select method from public.account_verifications where user_id = ${userId}`;
    expect(rows.length).toBe(1);
  });

  it("記録・要件の関数と表は、ブラウザのロールから使えない", async () => {
    const userId = await newUser();
    const link = await createSession(sql, userId, { amr: ["otp"] });
    for (const role of ["anon", "authenticated"] as const) {
      const claims = role === "anon" ? null : link.claims;
      expect(await fails(role, claims, (tx) => tx`select public.account_verification_record(${userId}, ${link.sessionId}, 'password_set')`)).toBe(true);
      expect(await fails(role, claims, (tx) => tx`select public.account_requirement_set(${userId}, 'confirm_or_set', 'self_signup', false)`)).toBe(true);
      expect(await fails(role, claims, (tx) => tx`insert into public.account_verifications (user_id, method) values (${userId}, 'legacy')`)).toBe(true);
      expect(await fails(role, claims, (tx) => tx`select * from public.account_lookup_for_signup('a@example.test')`)).toBe(true);
      expect(await fails(role, claims, (tx) => tx`select public.current_session_trusted()`)).toBe(true);
    }
  });
});

describe("ブラウザからの店舗データの読み書き(RLS)", () => {
  let active: SalonFixture;
  let activeClaims: string;
  let pending: SalonFixture;
  let pendingClaims: string;

  beforeAll(async () => {
    active = await createSalon(sql, { plan: "reviews", serviceStatus: "complimentary" });
    activeClaims = (await createSession(sql, active.userId)).claims;
    pending = await createSalon(sql, { plan: "reviews", serviceStatus: "pending" });
    pendingClaims = (await createSession(sql, pending.userId)).claims;
    // 利用開始待ちになる前に作られたアンケート(利用中から戻した店舗など)
    for (const s of [active, pending]) {
      await sql`insert into public.surveys (salon_id, name, is_active) values (${s.salonId}, 'アンケート', true)`;
    }
  });

  it("利用中の店舗のオーナーは、店舗・アンケートを読み書きできる", async () => {
    const salons = await as("authenticated", activeClaims, (tx) => tx`select id from public.salons`);
    expect(salons).toEqual([{ id: active.salonId }]);
    const surveys = await as("authenticated", activeClaims, (tx) => tx`select salon_id from public.surveys where salon_id = ${active.salonId}`);
    expect(surveys.length).toBe(1);
    expect(await fails("authenticated", activeClaims, (tx) => tx`update public.surveys set name = '変更' where salon_id = ${active.salonId}`)).toBe(false);
    expect(await fails("authenticated", activeClaims, (tx) => tx`update public.salons set description = '説明' where id = ${active.salonId}`)).toBe(false);
  });

  it("利用開始待ちのオーナーは、店舗を読めて登録内容だけ直せる。アンケートは読み書きできない", async () => {
    const salons = await as("authenticated", pendingClaims, (tx) => tx`select id, service_status from public.salons`);
    expect(salons).toEqual([{ id: pending.salonId, service_status: "pending" }]);
    const updated = await as("authenticated", pendingClaims, (tx) =>
      tx`update public.salons set name = '新しい店舗名', contact_name = '担当', contact_phone = '03-0000-0000' where id = ${pending.salonId} returning name`);
    expect(updated).toEqual([{ name: "新しい店舗名" }]);
    for (const column of ["description", "google_review_url", "onboarding_completed"]) {
      const value = column === "onboarding_completed" ? "true" : "'x'";
      expect(await fails("authenticated", pendingClaims, (tx) => tx.unsafe(`update public.salons set ${column} = ${value} where id = '${pending.salonId}'`))).toBe(true);
    }
    const surveys = await as("authenticated", pendingClaims, (tx) => tx`select id from public.surveys where salon_id = ${pending.salonId}`);
    expect(surveys).toEqual([]);
    const changed = await as("authenticated", pendingClaims, (tx) => tx`update public.surveys set name = '変更' where salon_id = ${pending.salonId} returning id`);
    expect(changed).toEqual([]);
    expect(
      await fails("authenticated", pendingClaims, (tx) => tx`insert into public.surveys (salon_id, name) values (${pending.salonId}, '新規')`),
    ).toBe(true);
    const [tpl] = await sql<{ id: string }[]>`select id from public.survey_templates limit 1`;
    if (tpl) {
      expect(
        await fails("authenticated", pendingClaims, (tx) => tx`select public.create_survey_from_template(${pending.salonId}, ${tpl.id}, '新規')`),
      ).toBe(true);
    }
  });

  it("区分・登録経路・契約・所有者はオーナーが変えられず、店舗の追加・削除もできない", async () => {
    // どれも今の値とは違う値にする(同じ値なら変更にならない)
    for (const set of ["service_status = 'test'", "registration_source = 'operator'", "plan = 'salonpack'"]) {
      expect(await fails("authenticated", activeClaims, (tx) => tx.unsafe(`update public.salons set ${set} where id = '${active.salonId}'`))).toBe(true);
    }
    for (const set of ["service_status = 'complimentary'", "registration_source = 'operator'", "plan = 'salonpack'"]) {
      expect(await fails("authenticated", pendingClaims, (tx) => tx.unsafe(`update public.salons set ${set} where id = '${pending.salonId}'`))).toBe(true);
    }
    const [profile] = await sql<{ id: string }[]>`select id from public.profiles where user_id = ${active.userId}`;
    expect(
      await fails("authenticated", activeClaims, (tx) => tx`insert into public.salons (owner_id, name, slug) values (${profile.id}, '二つ目', 'second-salon')`),
    ).toBe(true);
    const deleted = await as("authenticated", activeClaims, (tx) => tx`delete from public.salons where id = ${active.salonId} returning id`);
    expect(deleted).toEqual([]);
  });

  it("信頼できないセッション(削除済み・本人確認より前)では、店舗データを読めない", async () => {
    const gone = await createSession(sql, active.userId);
    await sql`delete from auth.sessions where id = ${gone.sessionId}`;
    expect(await as("authenticated", gone.claims, (tx) => tx`select id from public.salons`)).toEqual([]);
    // 公開中のアンケートは誰でも読める(お客様用ページ)。オーナーだけが読める非公開のアンケートで確かめる。
    const [draft] = await sql<{ id: string }[]>`insert into public.surveys (salon_id, name, is_active) values (${active.salonId}, '下書き', false) returning id`;
    expect(await as("authenticated", activeClaims, (tx) => tx`select id from public.surveys where id = ${draft.id}`)).toEqual([{ id: draft.id }]);
    expect(await as("authenticated", gone.claims, (tx) => tx`select id from public.surveys where id = ${draft.id}`)).toEqual([]);
    expect(await as("authenticated", gone.claims, (tx) => tx`update public.surveys set name = '乗っ取り' where id = ${draft.id} returning id`)).toEqual([]);
    const changed = await as("authenticated", gone.claims, (tx) => tx`update public.salons set name = '乗っ取り' where id = ${active.salonId} returning id`);
    expect(changed).toEqual([]);
  });

  it("お客様用ページ(anon)は、口コミを使える店舗の公開中のアンケートだけ読める", async () => {
    const visible = await as("anon", null, (tx) => tx`select salon_id from public.surveys where salon_id in ${sql([active.salonId, pending.salonId])}`);
    expect(visible).toEqual([{ salon_id: active.salonId }]);
  });

  it("0009 の notifications_mark_retry_outcome はブラウザから実行できても、何も変えられない(RLS のポリシーが無い)", async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into public.notification_history (salon_id, event_type, status) values (${active.salonId}, 'test', 'failed') returning id`;
    for (const role of ["anon", "authenticated"] as const) {
      await as(role, role === "anon" ? null : activeClaims, (tx) => tx`select public.notifications_mark_retry_outcome(${row.id}, 'sent', null)`);
    }
    const [after] = await sql`select status, attempts from public.notification_history where id = ${row.id}`;
    expect(after).toEqual({ status: "failed", attempts: 1 });
  });
});

describe("お客様自身による店舗の登録(create_own_salon)", () => {
  async function create(claims: string, slug = `o-${randomUUID().slice(0, 12)}`): Promise<{ result: string; salon_id?: string }> {
    const [row] = await commitAs(claims, (tx) =>
      tx<{ r: { result: string; salon_id?: string } }[]>`
        select public.create_own_salon('私のサロン', '山田 花子', 'エステ', null, '090-0000-0000', ${slug}) as r`);
    return row.r;
  }

  it("本人確認のあとのセッションで、利用開始待ち・口コミプランの店舗を1つだけ作る", async () => {
    const userId = await newUser();
    const link = await createSession(sql, userId, { amr: ["otp"] });
    expect((await create(link.claims)).result).toBe("untrusted_session");
    expect(await record(userId, link.sessionId)).toBe("recorded");
    const created = await create(link.claims);
    expect(created.result).toBe("created");
    const [s] = await sql`select plan, service_status, registration_source, contact_name from public.salons where id = ${created.salon_id!}`;
    expect(s).toEqual({ plan: "reviews", service_status: "pending", registration_source: "self_signup", contact_name: "山田 花子" });
    expect(await create(link.claims)).toEqual({ result: "already_exists", salon_id: created.salon_id });
    const [log] = await sql`select actor_kind, actor_user_id, target from public.operator_audit_log where salon_id = ${created.salon_id!}`;
    expect(log).toEqual({ actor_kind: "owner", actor_user_id: userId, target: "registration" });
  });

  it("同時に呼んでも店舗は1つ", async () => {
    const userId = await newUser();
    const link = await createSession(sql, userId, { amr: ["invite"] });
    await record(userId, link.sessionId);
    const results = await Promise.all([create(link.claims), create(link.claims), create(link.claims)]);
    expect(results.filter((r) => r.result === "created").length).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.salons s join public.profiles p on p.id = s.owner_id where p.user_id = ${userId}`;
    expect(n).toBe(1);
  });

  it("運営管理者・メール未確認は作れない", async () => {
    const operator = await createOperator(sql);
    const opSession = await createSession(sql, operator);
    expect((await create(opSession.claims)).result).toBe("operator");
    const unconfirmed = await newUser({ confirmed: false });
    await sql`insert into public.account_verifications (user_id, method) values (${unconfirmed}, 'legacy')`;
    const s = await createSession(sql, unconfirmed);
    expect((await create(s.claims)).result).toBe("email_unconfirmed");
  });

  it("運営管理者を店舗の所有者にできず、店舗を持つアカウントを運営管理者にできない(どの経路でも)", async () => {
    const operator = await createOperator(sql);
    const [profile] = await sql<{ id: string }[]>`select id from public.profiles where user_id = ${operator}`;
    await expect(sql`insert into public.salons (owner_id, name, slug, service_status) values (${profile.id}, '運営', ${`op-${operator.slice(0, 8)}`}, 'test')`).rejects.toThrow();
    const owner = await createSalon(sql);
    await expect(sql`insert into public.operator_admins (user_id, granted_by) values (${owner.userId}, 'test')`).rejects.toThrow();
  });
});

describe("TS の判定の写し(previewServiceAccess)と DB の判定", () => {
  it("利用区分 × プラン × 個別設定 × 提供状態 × 標準のすべてで同じ", async () => {
    const { previewServiceAccess } = await import("@/lib/ops/preview");
    await sql
      .begin(async (tx) => {
        await tx`insert into public.feature_catalog (feature_key, lifecycle) values ('test_status_matrix', 'available')`;
        await tx`insert into public.plan_feature_rules (plan, feature_key, default_enabled) values ('salonpack', 'test_status_matrix', true)`;
        const salons: Record<string, string> = {};
        for (const status of ["pending", "complimentary", "test"] as const) {
          for (const plan of ["reviews", "salonpack"] as const) {
            salons[`${status}:${plan}`] = (await createSalon(tx as unknown as Sql, { plan, serviceStatus: status })).salonId;
          }
        }
        let checked = 0;
        for (const lifecycle of ["available", "coming_soon", "ended"] as const) {
          await tx`update public.feature_catalog set lifecycle = ${lifecycle} where feature_key = 'test_status_matrix'`;
          for (const defaultEnabled of [true, false]) {
            await tx`update public.plan_feature_rules set default_enabled = ${defaultEnabled} where feature_key = 'test_status_matrix'`;
            for (const status of ["pending", "complimentary", "test"] as const) {
              for (const plan of ["reviews", "salonpack"] as const) {
                const salonId = salons[`${status}:${plan}`];
                for (const mode of ["inherit", "allow", "deny"] as const) {
                  await tx`delete from public.salon_feature_overrides where salon_id = ${salonId} and feature_key = 'test_status_matrix'`;
                  if (mode !== "inherit") {
                    await tx`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${salonId}, 'test_status_matrix', ${mode})`;
                  }
                  const [db] = await tx<{ allowed: boolean; reason: string }[]>`select * from public.salon_feature_access(${salonId}, 'test_status_matrix')`;
                  const rules = { reviews: {}, salonpack: { test_status_matrix: defaultEnabled } };
                  const ts = previewServiceAccess({ lifecycle, hasRuntime: false }, rules, plan, "test_status_matrix", mode, status);
                  expect({ lifecycle, defaultEnabled, status, plan, mode, ...ts }).toEqual({ lifecycle, defaultEnabled, status, plan, mode, allowed: db.allowed, reason: db.reason });
                  checked++;
                }
              }
            }
          }
        }
        expect(checked).toBe(108);
        throw new Error("rollback");
      })
      .catch((e) => {
        if ((e as Error).message !== "rollback") throw e;
      });
  });
});
