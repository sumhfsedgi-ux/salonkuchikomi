// 本人確認とセッションの方式(0025・lib/onboarding/verification.ts)が、実際の Supabase Auth で成り立つことを確かめる。
// テスト用の Supabase プロジェクトだけに接続する(scripts/testdb/target.mjs で確認)。メールは送らない:
// admin.generateLink はユーザーを作り、メールを送らずにトークンを返す。そのトークンを verifyOtp で検証して、
// 「メールのリンクを開いた本人」のセッションを作る。アドレスはすべて example.invalid(届かない予約のドメイン)。
//
// 確かめること(計画の「認証方式を先に検証する」):
//   1. 実際の session_id・amr と、DB の auth.sessions・auth.mfa_amr_claims が一致するか。サインアウトで行が消えるか
//   2. 本人確認より前に第三者が取ったトークンを、本人確認のあとも拒否できるか(REST・RPC・RLS・my_account_state・リフレッシュ)
//   3. 古いトークンで Supabase Auth を直接操作して、本人が設定した認証情報を取り戻せないか
//   4. 記録の関数の直接の呼び出し・パスワードのセッション・同時の操作で、記録が確定しないか
//   5. 正当な本人の再ログイン・パスワード再設定ができるか
//   6. 既存のオーナー(legacy)と運営の管理者が使えるか
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type postgres from "postgres";
import { closeConnections, openDirectConnections, setupNotificationsTestEnv } from "./setupNotificationsEnv";

type Verification = typeof import("@/lib/onboarding/verification");

let target: ReturnType<typeof setupNotificationsTestEnv>;
let db: postgres.Sql;
let connections: postgres.Sql[];
let admin: SupabaseClient;
let verification: Verification;
const createdUsers: string[] = [];
const observations: string[] = [];

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function anonClient(): SupabaseClient {
  return createClient(URL_(), ANON(), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
function email(tag: string): string {
  return `onb-${tag}-${Date.now()}-${randomBytes(3).toString("hex")}@example.invalid`;
}
function password(): string {
  return `Pw-${randomBytes(9).toString("base64url")}9a`;
}
function note(line: string) {
  observations.push(line);
}

/** メールのリンクを開いた本人のセッション(generateLink のトークンを verifyOtp で検証する)。 */
async function openLink(params: { type: "signup" | "invite" | "magiclink" | "recovery"; email: string; password?: string; verifyType?: string }) {
  const { data, error } = await admin.auth.admin.generateLink(
    params.type === "signup"
      ? { type: "signup", email: params.email, password: params.password! }
      : { type: params.type, email: params.email },
  );
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink(${params.type}) に失敗: ${error?.code ?? error?.message}`);
  if (data.user?.id && !createdUsers.includes(data.user.id)) createdUsers.push(data.user.id);
  const client = anonClient();
  const { data: verified, error: verifyError } = await client.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: (params.verifyType ?? (params.type === "signup" ? "email" : params.type)) as "email",
  });
  if (verifyError || !verified.session) throw new Error(`verifyOtp(${params.type}) に失敗: ${verifyError?.code ?? verifyError?.message}`);
  return { client, session: verified.session, hashedToken: data.properties.hashed_token };
}

async function passwordLogin(address: string, pw: string) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email: address, password: pw });
  return { client, session: data.session, error };
}

function claimsOf(accessToken: string): { session_id: string; amr: unknown; sub: string } {
  return JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
}

/** 古いアクセストークンで PostgREST を直接呼ぶ(クライアントの状態に頼らない)。 */
async function rest(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${URL_()}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON(), authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // そのまま
  }
  return { status: res.status, body };
}

/** 古いアクセストークンで Supabase Auth(GoTrue)を直接呼ぶ。 */
async function gotrue(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; code: string | null }> {
  const res = await fetch(`${URL_()}/auth/v1/${path}`, {
    method,
    headers: { apikey: ANON(), authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let code: string | null = null;
  try {
    const json = (await res.json()) as { error_code?: string; code?: string | number };
    code = (json.error_code ?? (typeof json.code === "string" ? json.code : null)) as string | null;
  } catch {
    // 本文なし
  }
  return { status: res.status, code };
}

async function accountState(token: string) {
  const r = await rest(token, "rpc/my_account_state", { method: "POST", body: "{}" });
  return { status: r.status, row: Array.isArray(r.body) ? (r.body[0] as Record<string, unknown> | undefined) : undefined };
}

async function sessionRow(sessionId: string) {
  const [row] = await db`select id, user_id, created_at, not_after from auth.sessions where id = ${sessionId}`;
  return row ?? null;
}

function deps(userClient: SupabaseClient) {
  return { userClient, admin, newAnonClient: anonClient };
}

beforeAll(async () => {
  target = setupNotificationsTestEnv();
  connections = await openDirectConnections(target, 1);
  db = connections[0];
  admin = createClient(URL_(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  verification = await import("@/lib/onboarding/verification");
  const [m] = await db`select to_regclass('public.account_verifications') is not null as ok`;
  if (!m.ok) throw new Error("テスト用 DB に 0025 が適用されていません(npm run testdb:migrate -- --apply)。");
});

afterAll(async () => {
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => undefined);
  if (connections) await closeConnections(connections);
  // 実際の値の記録(報告と設計書に写す)
  // 実際の値の記録(報告と設計書に写す)。TESTDB_OBSERVATIONS_FILE があれば、そのファイルにも書く。
  const text = ["[観察した実際の値]", ...observations, ""].join("\n");
  process.stdout.write(`\n${text}`);
  if (process.env.TESTDB_OBSERVATIONS_FILE) writeFileSync(process.env.TESTDB_OBSERVATIONS_FILE, text, "utf8");
});

describe("1. 実際の session_id・amr と DB の記録", () => {
  it("メールのリンクとパスワードで、amr と auth.sessions・auth.mfa_amr_claims が一致する", async () => {
    const addr = email("amr");
    const pw = password();
    const signup = await openLink({ type: "signup", email: addr, password: pw });
    const login = await passwordLogin(addr, pw);
    expect(login.error).toBeNull();
    const magic = await openLink({ type: "magiclink", email: addr });
    const recovery = await openLink({ type: "recovery", email: addr });
    for (const [label, token] of [
      ["signup(verifyOtp type=email)", signup.session.access_token],
      ["password", login.session!.access_token],
      ["magiclink", magic.session.access_token],
      ["recovery", recovery.session.access_token],
    ] as const) {
      const c = claimsOf(token);
      const rows = await db<{ authentication_method: string }[]>`
        select authentication_method from auth.mfa_amr_claims where session_id = ${c.session_id} order by authentication_method`;
      const s = await sessionRow(c.session_id);
      note(`amr ${label}: JWT=${JSON.stringify((c.amr as Array<{ method: string }>).map((a) => a.method ?? a))} / DB=${JSON.stringify(rows.map((r) => r.authentication_method))} / sessions 行=${s ? "あり" : "なし"}`);
      expect(s).not.toBeNull();
      expect(rows.length).toBeGreaterThan(0);
    }
    const invitee = email("amr-invite");
    const { data: created } = await admin.auth.admin.createUser({ email: invitee, email_confirm: false });
    createdUsers.push(created.user!.id);
    const invite = await openLink({ type: "invite", email: invitee });
    const ic = claimsOf(invite.session.access_token);
    const irows = await db<{ authentication_method: string }[]>`select authentication_method from auth.mfa_amr_claims where session_id = ${ic.session_id}`;
    note(`amr invite: JWT=${JSON.stringify((ic.amr as Array<{ method: string }>).map((a) => a.method ?? a))} / DB=${JSON.stringify(irows.map((r) => r.authentication_method))}`);
    const [pwRow] = await db`select (encrypted_password is not null and encrypted_password <> '') as has_password from auth.users where id = ${created.user!.id}`;
    note(`招待のリンクを検証したあと、パスワードの無かった招待ユーザーのパスワード: ${pwRow.has_password ? "付く(乱数)" : "無いまま"}`);
  });

  it("サインアウト(others / local)で auth.sessions の行が消える", async () => {
    const addr = email("signout");
    const pw = password();
    await openLink({ type: "signup", email: addr, password: pw });
    const a = await passwordLogin(addr, pw);
    const b = await passwordLogin(addr, pw);
    const c = await passwordLogin(addr, pw);
    const [sa, sb, sc] = [a, b, c].map((x) => claimsOf(x.session!.access_token).session_id);
    await a.client.auth.signOut({ scope: "others" });
    note(`signOut(others) のあと: 自分=${(await sessionRow(sa)) ? "残る" : "消える"} / ほか=${(await sessionRow(sb)) ? "残る" : "消える"}`);
    expect(await sessionRow(sb)).toBeNull();
    expect(await sessionRow(sc)).toBeNull();
    expect(await sessionRow(sa)).not.toBeNull();
    await a.client.auth.signOut({ scope: "local" });
    expect(await sessionRow(sa)).toBeNull();
  });
});

/** 第三者がパスワード P で、本人のアドレスを先に登録した状態を作る(確認メールは本人の受信箱に届く。ここでは送らない)。 */
async function attackerSignup(tag: string) {
  const victimEmail = email(tag);
  const attackerPassword = password();
  const { data, error } = await admin.auth.admin.generateLink({ type: "signup", email: victimEmail, password: attackerPassword });
  if (error || !data.user) throw new Error(`generateLink(signup) に失敗: ${error?.code}`);
  createdUsers.push(data.user.id);
  return { victimEmail, attackerPassword, userId: data.user.id, confirmToken: data.properties!.hashed_token };
}

/** 第三者は、本人がリンクを開いた後は P でログインできる(Supabase の段階)。そのセッションは信頼されず、何もできない。 */
async function attackerLogsInAfterConfirm(victimEmail: string, attackerPassword: string, userId: string) {
  const login = await passwordLogin(victimEmail, attackerPassword);
  expect(login.session).not.toBeNull();
  const token = login.session!.access_token;
  expect((await accountState(token)).row).toMatchObject({ email_confirmed: true, verified: false, session_trusted: false, email_link_session: false });
  const create = await rest(token, "rpc/create_own_salon", {
    method: "POST",
    body: JSON.stringify({ p_name: "乗っ取り", p_contact_name: "x", p_business_type: null, p_contact_email: null, p_contact_phone: null, p_slug: `atk-${randomUUID().slice(0, 8)}` }),
  });
  expect(create.body).toMatchObject({ result: "untrusted_session" });
  expect(await verification.verifyBySettingPassword(deps(login.client), password())).toEqual({ ok: false, reason: "not_email_link" });
  expect(await verification.verifyByCurrentPassword(deps(login.client), attackerPassword)).toEqual({ ok: false, reason: "not_email_link" });
  const direct = await rest(token, "rpc/account_verification_record", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_session_id: claimsOf(token).session_id, p_method: "password_set" }),
  });
  expect(direct.status).toBeGreaterThanOrEqual(400);
  const [count] = await db`select count(*)::int as n from public.account_verifications where user_id = ${userId}`;
  expect(count.n).toBe(0);
  return { client: login.client, token, refresh: login.session!.refresh_token, directStatus: direct.status };
}

/** 本人確認のあと、第三者の古いトークン・リフレッシュトークン・パスワードが、DB でも Supabase Auth でも使えないこと。 */
async function attackerLockedOut(
  attacker: { client: SupabaseClient; token: string; refresh: string },
  victimEmail: string,
  attackerPasswords: string[],
  label: string,
) {
  const sid = claimsOf(attacker.token).session_id;
  const rowGone = !(await sessionRow(sid));
  const st = await accountState(attacker.token);
  const salons = await rest(attacker.token, "salons?select=id");
  const create = await rest(attacker.token, "rpc/create_own_salon", {
    method: "POST",
    body: JSON.stringify({ p_name: "x", p_contact_name: "x", p_business_type: null, p_contact_email: null, p_contact_phone: null, p_slug: `atk2-${randomUUID().slice(0, 8)}` }),
  });
  expect(st.row?.session_trusted ?? false).toBe(false);
  expect(Array.isArray(salons.body) ? salons.body.length : 0).toBe(0);
  expect((create.body as { result?: string } | null)?.result).not.toBe("created");
  // Supabase Auth を古いアクセストークンで直接操作する(セッションの行が無いことを確かめてから。行があるとメールを送る操作があるため)
  expect(rowGone).toBe(true);
  const getUser = await gotrue(attacker.token, "GET", "user");
  const putPassword = await gotrue(attacker.token, "PUT", "user", { password: password() });
  const putEmail = await gotrue(attacker.token, "PUT", "user", { email: email("takeover") });
  expect(putPassword.status).toBeGreaterThanOrEqual(400);
  expect(putEmail.status).toBeGreaterThanOrEqual(400);
  const refreshed = await attacker.client.auth.refreshSession({ refresh_token: attacker.refresh });
  expect(refreshed.data.session).toBeNull();
  const relogins = await Promise.all(attackerPasswords.map((p) => passwordLogin(victimEmail, p)));
  for (const r of relogins) expect(r.session).toBeNull();
  note(
    `${label}: 第三者のセッションの行=${rowGone ? "消える" : "残る"} / my_account_state=HTTP ${st.status}・session_trusted=${String(st.row?.session_trusted)}` +
      ` / salons=${Array.isArray(salons.body) ? salons.body.length : "?"}行 / GoTrue GET /user=${getUser.status}(${getUser.code})` +
      ` PUT /user パスワード=${putPassword.status}(${putPassword.code}) メール=${putEmail.status}(${putEmail.code})` +
      ` / リフレッシュ=${refreshed.error ? `拒否(${refreshed.error.code})` : "使えた"} / P でログイン=${relogins.every((r) => r.error) ? "拒否" : "できた"}`,
  );
}

describe("2〜4. 第三者が先に作った未確認のアカウント(先回りの乗っ取り)", () => {
  it("A. 第三者は P でログインしたまま何もしない → 本人は入れ直しに失敗し、新しく設定 → 第三者は締め出される", async () => {
    const a = await attackerSignup("victim-a");
    const early = await passwordLogin(a.victimEmail, a.attackerPassword);
    note(`未確認のアカウントに P でログイン: ${early.error ? `拒否(${early.error.code})` : "できた"}`);
    expect(early.session).toBeNull();
    const victim = anonClient();
    const verified = await victim.auth.verifyOtp({ token_hash: a.confirmToken, type: "email" });
    expect(verified.error).toBeNull();
    const attacker = await attackerLogsInAfterConfirm(a.victimEmail, a.attackerPassword, a.userId);
    note(`第三者が記録の関数を REST で直接呼ぶ: HTTP ${attacker.directStatus}`);

    expect(await verification.verifyByCurrentPassword(deps(victim), password())).toEqual({ ok: false, reason: "password_mismatch" });
    const victimPassword = password();
    expect(await verification.verifyBySettingPassword(deps(victim), victimPassword)).toEqual({ ok: true, status: "recorded" });
    const victimToken = (await victim.auth.getSession()).data.session!.access_token;
    expect((await accountState(victimToken)).row).toMatchObject({ verified: true, session_trusted: true });
    const create = await rest(victimToken, "rpc/create_own_salon", {
      method: "POST",
      body: JSON.stringify({ p_name: "本人のサロン", p_contact_name: "本人", p_business_type: null, p_contact_email: null, p_contact_phone: null, p_slug: `vic-${randomUUID().slice(0, 8)}` }),
    });
    expect(create.body).toMatchObject({ result: "created" });
    await attackerLockedOut(attacker, a.victimEmail, [a.attackerPassword], "A(本人確認のあと)");
    // 本人の正当な再ログインは信頼される
    const relogin = await passwordLogin(a.victimEmail, victimPassword);
    expect(relogin.error).toBeNull();
    expect((await accountState(relogin.session!.access_token)).row).toMatchObject({ session_trusted: true });
    // 使用済みの確認のリンクは、もう一度は使えない
    const again = await anonClient().auth.verifyOtp({ token_hash: a.confirmToken, type: "email" });
    note(`使用済みの確認のリンク: ${again.error ? `拒否(${again.error.code})` : "使えた"}`);
    expect(again.error).not.toBeNull();
    expect(again.data.session).toBeNull();
  });

  it("B. 第三者が先にパスワードを変える → 本人のリンクのセッションは消える → 本人は新しいリンクで設定 → 第三者は締め出される", async () => {
    const b = await attackerSignup("victim-b");
    const victim = anonClient();
    expect((await victim.auth.verifyOtp({ token_hash: b.confirmToken, type: "email" })).error).toBeNull();
    const victimSid = claimsOf((await victim.auth.getSession()).data.session!.access_token).session_id;
    const attacker = await attackerLogsInAfterConfirm(b.victimEmail, b.attackerPassword, b.userId);
    const p2 = `${b.attackerPassword}x`;
    const changed = await gotrue(attacker.token, "PUT", "user", { password: p2 });
    note(`本人確認の前に第三者が PUT /user(パスワード): HTTP ${changed.status} / 本人のリンクのセッションの行=${(await sessionRow(victimSid)) ? "残る" : "消える"}`);
    expect((await accountState(attacker.token)).row).toMatchObject({ verified: false, session_trusted: false });
    // 本人の手続きは失敗する(記録しない)
    const failed = await verification.verifyBySettingPassword(deps(victim), password());
    note(`B: 本人のリンクのセッションが消えたあとの手続き: ${JSON.stringify(failed)}`);
    expect(failed).toEqual({ ok: false, reason: "session_expired" });
    expect(failed.ok).toBe(false);
    const [count] = await db`select count(*)::int as n from public.account_verifications where user_id = ${b.userId}`;
    expect(count.n).toBe(0);
    // 本人は新しいリンク(パスワード再設定のリンク。受信箱は本人だけのもの)で設定し直す
    const fresh = await openLink({ type: "recovery", email: b.victimEmail });
    expect(await verification.verifyBySettingPassword(deps(fresh.client), password())).toEqual({ ok: true, status: "recorded" });
    await attackerLockedOut(attacker, b.victimEmail, [b.attackerPassword, p2], "B(新しいリンクで本人確認のあと)");
  });
});

describe("運営による招待・紐付け", () => {
  it("パスワード無しで作ったアカウントの招待: リンクで乱数のパスワードが付いても未確認のまま。設定すると記録される", async () => {
    const addr = email("invite");
    const { data } = await admin.auth.admin.createUser({ email: addr, email_confirm: false });
    createdUsers.push(data.user!.id);
    await admin.rpc("account_requirement_set", { p_user_id: data.user!.id, p_mode: "set_new", p_reason: "operator_invite", p_only_if_absent: false });
    const link = await openLink({ type: "invite", email: addr });
    const before = await accountState(link.session.access_token);
    expect(before.row).toMatchObject({ email_confirmed: true, verified: false, verification_mode: "set_new", email_link_session: true, session_trusted: false });
    const pw = password();
    expect(await verification.verifyBySettingPassword(deps(link.client), pw)).toEqual({ ok: true, status: "recorded" });
    expect((await accountState(link.session.access_token)).row).toMatchObject({ verified: true, session_trusted: true });
    expect((await passwordLogin(addr, pw)).error).toBeNull();
  });

  it("未確認のアカウントを運営が紐付けると(パスワードを乱数に変える)、第三者の P は確認のあとも使えない", async () => {
    const addr = email("rebind");
    const p = password();
    const { data } = await admin.auth.admin.generateLink({ type: "signup", email: addr, password: p });
    createdUsers.push(data.user!.id);
    const { error } = await admin.auth.admin.updateUserById(data.user!.id, { password: `${randomBytes(32).toString("base64url")}Aa1` });
    expect(error).toBeNull();
    const link = await openLink({ type: "invite", email: addr });
    expect(link.session).toBeTruthy();
    const attempt = await passwordLogin(addr, p);
    note(`運営が紐付けた(乱数に変えた)あと、本人が招待のリンクを開いてからの P でのログイン: ${attempt.error ? `拒否(${attempt.error.code})` : "できた"}`);
    expect(attempt.session).toBeNull();
  });
});

describe("記録の同時の操作", () => {
  // Supabase Auth はパスワードを変えると、ほかのセッションを消す(testdb で確認)。同時に設定すると互いのセッションを消し合い、
  // どちらも記録できないことがある。そのときも記録が誤って確定しないこと、記録は多くても1つであることを確かめる。
  it("同じアカウントの2つのメールのリンクのセッションで同時に設定しても、記録は多くても1つで、誤って確定しない", async () => {
    const addr = email("race");
    const { data } = await admin.auth.admin.createUser({ email: addr, email_confirm: false });
    createdUsers.push(data.user!.id);
    const a = await openLink({ type: "invite", email: addr });
    const b = await openLink({ type: "magiclink", email: addr });
    const [ra, rb] = await Promise.all([
      verification.verifyBySettingPassword(deps(a.client), password()),
      verification.verifyBySettingPassword(deps(b.client), password()),
    ]);
    note(`同時の設定: a=${JSON.stringify(ra)} / b=${JSON.stringify(rb)}`);
    const [rows] = await db`select count(*)::int as n, max(method) as method from public.account_verifications where user_id = ${data.user!.id}`;
    expect(rows.n).toBeLessThanOrEqual(1);
    if (rows.n === 1) {
      const [v] = await db`select verified_session_id from public.account_verifications where user_id = ${data.user!.id}`;
      expect(await sessionRow(v.verified_session_id)).not.toBeNull();
    }
    const trusted = [
      (await accountState(a.session.access_token)).row?.session_trusted ?? false,
      (await accountState(b.session.access_token)).row?.session_trusted ?? false,
    ];
    note(`同時の設定のあと、信頼されるセッション: a=${trusted[0]} / b=${trusted[1]}`);
    expect(trusted.filter(Boolean).length).toBeLessThanOrEqual(1);
  });
});

describe("5〜6. 正当な本人・既存のオーナー・運営の管理者", () => {
  it("パスワード再設定(既存の画面と同じ recovery のリンク)で設定したあと、新しいパスワードでログインでき、信頼される", async () => {
    const addr = email("reset");
    const { data } = await admin.auth.admin.createUser({ email: addr, email_confirm: true, password: password() });
    createdUsers.push(data.user!.id);
    const recovery = await openLink({ type: "recovery", email: addr });
    const pw = password();
    const r = await verification.resetPasswordWithRecoverySession(deps(recovery.client), pw);
    expect(r).toEqual({ ok: true, verified: true });
    await recovery.client.auth.signOut({ scope: "local" });
    const login = await passwordLogin(addr, pw);
    expect(login.error).toBeNull();
    expect((await accountState(login.session!.access_token)).row).toMatchObject({ verified: true, session_trusted: true });
  });

  it("既存のオーナー(legacy)は、パスワードでログインしたセッションで店舗を読める。サインアウトしたトークンは使えない", async () => {
    const addr = email("legacy");
    const pw = password();
    const { data } = await admin.auth.admin.createUser({ email: addr, email_confirm: true, password: pw });
    createdUsers.push(data.user!.id);
    await db`insert into public.account_verifications (user_id, method) values (${data.user!.id}, 'legacy')`;
    const [profile] = await db<{ id: string }[]>`select id from public.profiles where user_id = ${data.user!.id}`;
    const [salon] = await db<{ id: string }[]>`
      insert into public.salons (owner_id, name, slug, plan, service_status) values (${profile.id}, '既存の店舗', ${`legacy-${randomUUID().slice(0, 8)}`}, 'salonpack', 'complimentary')
      returning id`;
    const login = await passwordLogin(addr, pw);
    const token = login.session!.access_token;
    expect((await rest(token, "salons?select=id")).body).toEqual([{ id: salon.id }]);
    await login.client.auth.signOut({ scope: "local" });
    expect((await rest(token, "salons?select=id")).body).toEqual([]);
  });

  it("運営の管理者(legacy)は信頼され、my_account_state で管理者とわかる", async () => {
    const addr = email("operator");
    const pw = password();
    const { data } = await admin.auth.admin.createUser({ email: addr, email_confirm: true, password: pw });
    createdUsers.push(data.user!.id);
    await db`insert into public.account_verifications (user_id, method) values (${data.user!.id}, 'legacy')`;
    await db`insert into public.operator_admins (user_id, granted_by, note) values (${data.user!.id}, 'testdb', 'auth-verification')`;
    const login = await passwordLogin(addr, pw);
    expect((await accountState(login.session!.access_token)).row).toMatchObject({ is_operator: true, session_trusted: true });
  });
});
