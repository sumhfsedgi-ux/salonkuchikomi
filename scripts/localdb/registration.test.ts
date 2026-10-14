// 0025 の運営の操作(下書き・本登録・利用区分の変更・招待と案内の記録・一覧)を、ローカルの PostgreSQL で確かめる。
// アカウントの用意(作成・パスワードの無効化)はアプリが Supabase Auth で行う。ここでは DB の関数が条件を確かめることを見る。
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { createOperator, createSalon, createSession, makeReservationActive, openHolds } from "./fixtures";

const DB = "salonpack_localdb_registration";
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

async function saveDraft(fields: Record<string, unknown>, draftId: string | null = null, version: number | null = null, actor = operator): Promise<Result> {
  const [row] = await sql<{ r: Result }[]>`
    select public.admin_save_salon_draft(${actor}, ${draftId}, ${version}, ${sql.json(fields as never)}) as r`;
  return row.r;
}

async function register(draftId: string, version: number, ownerUserId: string, slug = `r-${randomUUID().slice(0, 12)}`, actor = operator): Promise<Result> {
  const [row] = await sql<{ r: Result }[]>`
    select public.admin_register_salon(${actor}, ${draftId}, ${version}, ${ownerUserId}, ${slug}, ${randomUUID()}) as r`;
  return row.r;
}

/** アプリが新しいアドレスで用意するアカウント(未確認・パスワード無し・set_new)。 */
async function invitedAccount(email: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, email) values (${id}, ${email})`;
  await sql`select public.account_requirement_set(${id}, 'set_new', 'operator_invite', false)`;
  return id;
}

async function confirmedAccount(email: string, verified: boolean): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, email, email_confirmed_at) values (${id}, ${email}, now())`;
  if (verified) {
    const s = await createSession(sql, id, { amr: ["otp"] });
    const [r] = await sql<{ r: string }[]>`select public.account_verification_record(${id}, ${s.sessionId}, 'password_set') as r`;
    expect(r.r).toBe("recorded");
  }
  return id;
}

function fullDraft(email: string, extra: Record<string, unknown> = {}) {
  return { name: "運営が登録するサロン", contact_name: "担当 太郎", login_email: email, plan: "salonpack", service_status: "pending", ...extra };
}

describe("下書き", () => {
  it("サロン名だけで保存でき、アカウントも店舗も作らない", async () => {
    const before = await sql`select (select count(*)::int from public.salons) as salons, (select count(*)::int from auth.users) as users`;
    const r = await saveDraft({ name: "名前だけ" });
    expect(r).toMatchObject({ result: "saved", version: 0 });
    const after = await sql`select (select count(*)::int from public.salons) as salons, (select count(*)::int from auth.users) as users`;
    expect(after).toEqual(before);
  });

  it("項目の誤り・版数の違い・管理者でない・カタログに無い機能は保存しない", async () => {
    expect((await saveDraft({ name: "" })).result).toBe("invalid:name");
    expect((await saveDraft({ name: "x", login_email: "not-an-email" })).result).toBe("invalid:login_email");
    expect((await saveDraft({ name: "x", contact_phone: "電話" })).result).toBe("invalid:contact_phone");
    expect((await saveDraft({ name: "x", plan: "gold" })).result).toBe("invalid:plan");
    expect((await saveDraft({ name: "x", feature_overrides: { unknown_feature: "allow" } })).result).toBe("invalid:feature_overrides");
    expect((await saveDraft({ name: "x", feature_overrides: { blog: "maybe" } })).result).toBe("invalid:feature_overrides");
    const owner = await createSalon(sql);
    expect((await saveDraft({ name: "x" }, null, null, owner.userId)).result).toBe("not_operator");
    const r = await saveDraft({ name: "版数" });
    expect((await saveDraft({ name: "版数2" }, r.draft_id as string, 0)).result).toBe("saved");
    expect((await saveDraft({ name: "版数3" }, r.draft_id as string, 0)).result).toBe("conflict");
  });
});

describe("本登録", () => {
  it("必須の項目がそろわないと登録しない", async () => {
    const email = `need-${randomUUID().slice(0, 8)}@example.test`;
    const user = await invitedAccount(email);
    const r = await saveDraft({ name: "不足", login_email: email });
    expect((await register(r.draft_id as string, 0, user)).result).toBe("incomplete:contact_name");
  });

  it("新しいアカウント: 指定したプラン・区分・機能で店舗を作り、招待の行と履歴を書く。同じ下書きの再登録は同じ店舗を返す", async () => {
    const email = `new-${randomUUID().slice(0, 8)}@example.test`;
    const user = await invitedAccount(email);
    const d = await saveDraft(fullDraft(email, { service_status: "complimentary", feature_overrides: { blog: "deny" } }));
    const r = await register(d.draft_id as string, 0, user);
    expect(r.result).toBe("registered");
    const salonId = r.salon_id as string;
    const [s] = await sql`select plan, service_status, registration_source, contact_name, contact_email from public.salons where id = ${salonId}`;
    expect(s).toEqual({ plan: "salonpack", service_status: "complimentary", registration_source: "operator", contact_name: "担当 太郎", contact_email: null });
    const overrides = await sql`select feature_key, mode from public.salon_feature_overrides where salon_id = ${salonId}`;
    expect(overrides).toEqual([{ feature_key: "blog", mode: "deny" }]);
    const [inv] = await sql`select user_id, login_email, last_result from public.salon_invitations where salon_id = ${salonId}`;
    expect(inv).toEqual({ user_id: user, login_email: email, last_result: null });
    const [log] = await sql`select actor_kind, actor_user_id, target from public.operator_audit_log where salon_id = ${salonId} and target = 'registration'`;
    expect(log).toEqual({ actor_kind: "operator", actor_user_id: operator, target: "registration" });
    expect(await register(d.draft_id as string, 0, user)).toEqual({ result: "already_registered", salon_id: salonId });
    expect(await register(d.draft_id as string, 1, user)).toEqual({ result: "already_registered", salon_id: salonId });
    const [{ n }] = await sql`select count(*)::int as n from public.salons s join public.profiles p on p.id = s.owner_id where p.user_id = ${user}`;
    expect(n).toBe(1);
  });

  it("口コミプランでは、対象外の機能の個別設定を登録しない", async () => {
    const email = `rev-${randomUUID().slice(0, 8)}@example.test`;
    const user = await invitedAccount(email);
    const d = await saveDraft(fullDraft(email, { plan: "reviews", feature_overrides: { blog: "allow", reviews: "deny" } }));
    const r = await register(d.draft_id as string, 0, user);
    const overrides = await sql`select feature_key, mode from public.salon_feature_overrides where salon_id = ${r.salon_id as string} order by feature_key`;
    expect(overrides).toEqual([{ feature_key: "reviews", mode: "deny" }]);
  });

  it("利用開始待ちで登録した店舗は、サービスを使えない", async () => {
    const email = `pend-${randomUUID().slice(0, 8)}@example.test`;
    const user = await invitedAccount(email);
    const d = await saveDraft(fullDraft(email));
    const r = await register(d.draft_id as string, 0, user);
    const [a] = await sql`select allowed, reason from public.salon_feature_access(${r.salon_id as string}, 'reviews')`;
    expect(a).toEqual({ allowed: false, reason: "service_pending" });
  });

  it("紐付け先の条件: アドレスの一致・管理者でない・店舗を持たない・本人確認(確認済み)・set_new(未確認)", async () => {
    const mk = async (email: string) => (await saveDraft(fullDraft(email))).draft_id as string;
    const e1 = `mismatch-${randomUUID().slice(0, 8)}@example.test`;
    const other = await invitedAccount(`other-${randomUUID().slice(0, 8)}@example.test`);
    expect((await register(await mk(e1), 0, other)).result).toBe("email_mismatch");

    const opEmail = `op-${randomUUID().slice(0, 8)}@example.test`;
    const op = await createOperator(sql, opEmail);
    expect((await register(await mk(opEmail), 0, op)).result).toBe("owner_is_operator");

    const owner = await createSalon(sql);
    const [{ email: ownerEmail }] = await sql<{ email: string }[]>`select email from auth.users where id = ${owner.userId}`;
    expect(await register(await mk(ownerEmail), 0, owner.userId)).toEqual({ result: "owner_has_salon", salon_id: owner.salonId });

    const unverifiedEmail = `unv-${randomUUID().slice(0, 8)}@example.test`;
    const unverified = await confirmedAccount(unverifiedEmail, false);
    expect((await register(await mk(unverifiedEmail), 0, unverified)).result).toBe("owner_unverified");

    const verifiedEmail = `ver-${randomUUID().slice(0, 8)}@example.test`;
    const verified = await confirmedAccount(verifiedEmail, true);
    expect((await register(await mk(verifiedEmail), 0, verified)).result).toBe("registered");

    const noReqEmail = `noreq-${randomUUID().slice(0, 8)}@example.test`;
    const noReq = randomUUID();
    await sql`insert into auth.users (id, email) values (${noReq}, ${noReqEmail})`;
    expect((await register(await mk(noReqEmail), 0, noReq)).result).toBe("owner_requirement_missing");

    expect((await register(await mk(`x-${randomUUID().slice(0, 8)}@example.test`), 0, other, "x", owner.userId)).result).toBe("not_operator");
  });

  it("同じ下書きを同時に登録しても、店舗は1つ", async () => {
    const email = `race-${randomUUID().slice(0, 8)}@example.test`;
    const user = await invitedAccount(email);
    const d = await saveDraft(fullDraft(email));
    const results = await Promise.all([1, 2, 3].map(() => register(d.draft_id as string, 0, user)));
    expect(results.filter((r) => r.result === "registered").length).toBe(1);
    const ids = new Set(results.map((r) => r.salon_id));
    expect(ids.size).toBe(1);
  });

  it("運営の本登録とお客様の店舗の登録が同時でも、所有者の店舗は1つ", async () => {
    const email = `both-${randomUUID().slice(0, 8)}@example.test`;
    const user = await confirmedAccount(email, true);
    const session = await createSession(sql, user);
    const d = await saveDraft(fullDraft(email));
    const own = sql.begin(async (tx) => {
      await tx.unsafe("set local role authenticated");
      await tx`select set_config('request.jwt.claims', ${session.claims}, true)`;
      const [row] = await tx<{ r: Result }[]>`select public.create_own_salon('自分で', '本人', null, null, null, ${`own-${randomUUID().slice(0, 8)}`}) as r`;
      return row.r;
    });
    const [a, b] = await Promise.all([own, register(d.draft_id as string, 0, user)]);
    const created = [a.result === "created", b.result === "registered"].filter(Boolean).length;
    expect(created).toBe(1);
    expect(a.result === "created" ? b.result : a.result).toBe(a.result === "created" ? "owner_has_salon" : "already_exists");
    const [{ n }] = await sql`select count(*)::int as n from public.salons s join public.profiles p on p.id = s.owner_id where p.user_id = ${user}`;
    expect(n).toBe(1);
  });
});

describe("利用区分の変更(管理画面)", () => {
  it("版数と区分を比べて変える。プラン・個別設定・停止はそのまま。予約通知は再開しない", async () => {
    const s = await createSalon(sql, { plan: "salonpack", serviceStatus: "complimentary" });
    await makeReservationActive(sql, s.salonId);
    const version = async () => Number((await sql`select version from public.salon_entitlement_state where salon_id = ${s.salonId}`)[0].version);
    const change = async (expectedVersion: number, expected: string, next: string, actor = operator) =>
      (await sql<{ r: Result }[]>`select public.admin_update_salon_service_status(${actor}, ${s.salonId}, ${expectedVersion}, ${expected}, ${next}, 'テスト', ${randomUUID()}) as r`)[0].r;
    const v0 = await version();
    expect((await change(v0, "pending", "test")).result).toBe("conflict");
    expect((await change(v0 + 1, "complimentary", "test")).result).toBe("conflict");
    expect((await change(v0, "complimentary", "complimentary")).result).toBe("no_change");
    expect((await change(v0, "complimentary", "pending", s.userId)).result).toBe("not_operator");
    expect((await change(v0, "complimentary", "gold")).result).toBe("invalid");
    const saved = await change(v0, "complimentary", "pending");
    expect(saved.result).toBe("saved");
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
    expect((await change(saved.version as number, "pending", "test")).result).toBe("saved");
    expect(await openHolds(sql, s.salonId)).toEqual(["reservation_notifications"]);
    const [{ plan }] = await sql`select plan from public.salons where id = ${s.salonId}`;
    expect(plan).toBe("salonpack");
    const logs = await sql`select actor_kind, actor_user_id, before, after, note from public.operator_audit_log where salon_id = ${s.salonId} and target = 'service_status' order by id`;
    expect(logs).toEqual([
      { actor_kind: "operator", actor_user_id: operator, before: "complimentary", after: "pending", note: "テスト" },
      { actor_kind: "operator", actor_user_id: operator, before: "pending", after: "test", note: "テスト" },
    ]);
  });
});

describe("招待と案内の記録", () => {
  async function registered(kind: "new" | "verified" | "unverified_confirmed"): Promise<{ salonId: string; userId: string }> {
    const email = `inv-${randomUUID().slice(0, 8)}@example.test`;
    const user = kind === "new" ? await invitedAccount(email) : await confirmedAccount(email, true);
    const d = await saveDraft(fullDraft(email));
    const r = await register(d.draft_id as string, 0, user);
    if (kind === "unverified_confirmed") {
      // 招待のリンクを開いた(メールは確認済み)が、パスワードを設定していない状態
      await sql`delete from public.account_verifications where user_id = ${user}`;
    }
    return { salonId: r.salon_id as string, userId: user };
  }
  const begin = async (salonId: string, actor = operator) =>
    (await sql<{ r: Result }[]>`select public.admin_invitation_begin(${actor}, ${salonId}, ${randomUUID()}) as r`)[0].r;
  const finish = async (attemptId: string, result: string, code: string | null = null) =>
    (await sql<{ r: string }[]>`select public.admin_invitation_finish(${operator}, ${attemptId}, ${result}, ${code}) as r`)[0].r;

  it("種類はアカウントの状態で決まる(未確認=招待 / 本人確認済み=店舗登録のお知らせ / 確認済みで本人確認がまだ=本人確認のリンク)", async () => {
    expect((await begin((await registered("new")).salonId)).kind).toBe("invite");
    expect((await begin((await registered("verified")).salonId)).kind).toBe("salon_notice");
    expect((await begin((await registered("unverified_confirmed")).salonId)).kind).toBe("verify_link");
  });

  it("60秒あける・結果を記録する・送信の受付と失敗を分ける・初回の受付日時は1回だけ", async () => {
    const { salonId } = await registered("new");
    const a = await begin(salonId);
    expect(a.result).toBe("ok");
    expect((await begin(salonId)).result).toBe("cooldown");
    expect(await finish(a.attempt_id as string, "failed", "rate_limited")).toBe("ok");
    expect(await finish(a.attempt_id as string, "accepted")).toBe("already_finished");
    let [inv] = await sql`select last_result, last_error, last_accepted_at, first_accepted_at from public.salon_invitations where salon_id = ${salonId}`;
    expect(inv).toMatchObject({ last_result: "failed", last_error: "rate_limited", last_accepted_at: null, first_accepted_at: null });
    // 60秒たったことにする
    await sql`update public.salon_invitation_attempts set started_at = started_at - interval '61 seconds' where salon_id = ${salonId}`;
    const b = await begin(salonId);
    expect(b.result).toBe("ok");
    expect(await finish(b.attempt_id as string, "accepted")).toBe("ok");
    [inv] = await sql`select last_result, last_error, last_accepted_at, first_accepted_at from public.salon_invitations where salon_id = ${salonId}`;
    expect(inv.last_result).toBe("accepted");
    expect(inv.last_error).toBeNull();
    expect(inv.first_accepted_at).not.toBeNull();
    const logs = await sql`select after from public.operator_audit_log where salon_id = ${salonId} and target = 'invitation' order by id`;
    expect(logs.map((l) => l.after)).toEqual([
      { kind: "invite", result: "failed", error: "rate_limited" },
      { kind: "invite", result: "accepted", error: null },
    ]);
  });

  it("古い試行の結果が、あとの試行の結果を上書きしない", async () => {
    const { salonId } = await registered("new");
    const a = await begin(salonId);
    await sql`update public.salon_invitation_attempts set started_at = started_at - interval '61 seconds' where id = ${a.attempt_id as string}`;
    const b = await begin(salonId);
    expect(await finish(b.attempt_id as string, "accepted")).toBe("ok");
    expect(await finish(a.attempt_id as string, "failed", "send_failed")).toBe("ok");
    const [inv] = await sql`select last_result from public.salon_invitations where salon_id = ${salonId}`;
    expect(inv.last_result).toBe("accepted");
  });

  it("24時間で10回まで。同時に始めても1回だけ", async () => {
    const { salonId } = await registered("verified");
    const results = await Promise.all([1, 2, 3].map(() => begin(salonId)));
    expect(results.filter((r) => r.result === "ok").length).toBe(1);
    for (let i = 0; i < 9; i++) {
      await sql`insert into public.salon_invitation_attempts (salon_id, actor_user_id, kind, started_at, finished_at, result)
                values (${salonId}, ${operator}, 'salon_notice', now() - interval '2 hours', now() - interval '2 hours', 'accepted')`;
    }
    await sql`update public.salon_invitation_attempts set started_at = started_at - interval '61 seconds' where salon_id = ${salonId}`;
    expect((await begin(salonId)).result).toBe("daily_limit");
  });

  it("お客様が自分で登録した店舗には招待の行が無い", async () => {
    const s = await createSalon(sql);
    expect((await begin(s.salonId)).result).toBe("no_invitation");
  });
});

describe("一覧と詳細", () => {
  it("利用区分で絞り込め、区分・登録経路・招待の状態を返す。7つの引数の呼び出しも動く", async () => {
    const pending = await createSalon(sql, { serviceStatus: "pending" });
    const rows = await sql`
      select id, service_status, registration_source, invitation_state
        from public.admin_list_salons(null, null, null, null, null, null, 200, 'pending')`;
    expect(rows.every((r) => r.service_status === "pending")).toBe(true);
    expect(rows.some((r) => r.id === pending.salonId)).toBe(true);
    const all = await sql`select id from public.admin_list_salons(null, null, null, null, null, null, 200)`;
    expect(all.length).toBeGreaterThan(rows.length);
  });

  it("招待の状態は、メールの確認と本人確認の記録で「完了」になる", async () => {
    const email = `state-${randomUUID().slice(0, 8)}@example.test`;
    const user = await invitedAccount(email);
    const d = await saveDraft(fullDraft(email));
    const r = await register(d.draft_id as string, 0, user);
    const stateOf = async () =>
      (await sql`select invitation_state from public.admin_list_salons(null, null, null, null, null, null, 200) where id = ${r.salon_id as string}`)[0].invitation_state;
    expect(await stateOf()).toBe("incomplete");
    await sql`update auth.users set email_confirmed_at = now() where id = ${user}`;
    expect(await stateOf()).toBe("incomplete");
    const s = await createSession(sql, user, { amr: ["otp"] });
    await sql`select public.account_verification_record(${user}, ${s.sessionId}, 'password_set')`;
    expect(await stateOf()).toBe("complete");
    const [detail] = await sql`select * from public.admin_salon_onboarding(${r.salon_id as string})`;
    expect(detail).toMatchObject({ registration_source: "operator", owner_email_confirmed: true, owner_verified: true, owner_verification_method: "password_set", has_invitation: true });
  });

  it("管理用の関数・表は、ブラウザのロールから使えない", async () => {
    const owner = await createSalon(sql);
    const s = await createSession(sql, owner.userId);
    const calls = [
      `select public.admin_save_salon_draft('${operator}', null, null, '{"name":"x"}'::jsonb)`,
      `select public.admin_register_salon('${operator}', '${randomUUID()}', 0, '${owner.userId}', 'x', null)`,
      `select public.admin_update_salon_service_status('${operator}', '${owner.salonId}', 0, 'complimentary', 'test', null, null)`,
      `select public.admin_account_lookup('${operator}', 'a@example.test')`,
      `select public.admin_invitation_begin('${operator}', '${owner.salonId}', null)`,
      `select public.admin_invitation_finish('${operator}', '${randomUUID()}', 'accepted', null)`,
      `select * from public.admin_salon_onboarding('${owner.salonId}')`,
      `select * from public.salon_drafts`,
      `select * from public.salon_invitations`,
      `select * from public.salon_invitation_attempts`,
    ];
    for (const q of calls) {
      let failed = false;
      await sql
        .begin(async (tx) => {
          await tx.unsafe("set local role authenticated");
          await tx`select set_config('request.jwt.claims', ${s.claims}, true)`;
          try {
            await tx.savepoint((sp) => sp.unsafe(q));
          } catch {
            failed = true;
          }
          throw new Error("__rollback__");
        })
        .catch((e) => {
          if ((e as Error).message !== "__rollback__") throw e;
        });
      expect(failed, q).toBe(true);
    }
  });
});
