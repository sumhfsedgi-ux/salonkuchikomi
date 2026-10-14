/**
 * 既存のパスワード再設定の通しの確認(テスト用の DB)。既存の画面の実際の処理を通す:
 *   ログイン画面「パスワードをお忘れですか？」→ /forgot-password「再設定メールを送る」→ メールのリンク(GoTrue の /verify)
 *   → /reset-password(PKCE の code を交換)→ 新しいパスワードを保存(resetPasswordAction)→ サインアウト → /login?reset=1
 *   → 新しいパスワードでログイン → 行き先
 * 対象: 既存店舗のオーナー・既存の運営管理者・本人確認が未完了の新規アカウント(メール未確認/リンクは開いたがパスワードの手続き前/
 *       運営が招待したが招待を使っていない)。
 *
 * メールは送らない。ここだけ、実際の処理の代わりに同じ状態を作る:
 *   - ブラウザが送る「再設定メールを送る」の要求(POST /auth/v1/recover。code_challenge 付き)は、ここで受け止めて GoTrue に届けない
 *     (応答は GoTrue の成功と同じ 200 {})。ほかのメールを送る要求(otp・magiclink・signup・resend・invite)は止めて、失敗として数える。
 *   - /recover がサーバーで作るもの(GoTrue v2.197.0 の recover.go・mail.go と同じ値):
 *       PKCE のフロー状態: auth.flow_state に1行(provider_type・authentication_method = recovery、ブラウザの code_challenge)
 *       再設定のトークン: admin.generateLink(recovery。メールを送らない)で作り、PKCE の印 pkce_ を付ける(addFlowPrefixToToken と同じ)
 *   - リンクは「Reset password」のテンプレートの {{ .ConfirmationURL }} と同じ形(<Supabase>/auth/v1/verify?token=pkce_…&type=recovery&redirect_to=…)。
 * ここから先(GoTrue の検証・PKCE の交換・画面・保存・サインアウト・ログイン)は、実際の処理をそのまま通す。
 * アドレスは example.invalid だけ。既存の画面・本番には触れない。
 *
 *   npm i --no-save playwright-core
 *   npx tsx scripts/testdb/password-reset-walkthrough.ts [--channel=chrome|msedge] [--headed]
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { randomBytes } from "node:crypto";
import { assertTestDatabase, buildChildEnv, databaseOptions, loadTestTarget } from "./target.mjs";

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const channel = process.argv.find((a) => a.startsWith("--channel="))?.split("=")[1] ?? "chrome";
const headed = process.argv.includes("--headed");

const target = loadTestTarget({ requireDatabaseUrl: true });
const childEnv = buildChildEnv(target, process.env, PORT) as Record<string, string>;
childEnv.NEXT_PUBLIC_APP_MODE = "salonpack";
childEnv.SELF_SIGNUP_ENABLED = "1";
for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;
const SUPABASE_URL = childEnv.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = childEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

interface Locator {
  click(): Promise<void>;
  check(): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  first(): Locator;
  locator(selector: string): Locator;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
  selectOption(value: string): Promise<unknown>;
}
interface Frame {
  url(): string;
  parentFrame(): Frame | null;
}
interface Page {
  goto(url: string): Promise<unknown>;
  url(): string;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp): Locator;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  reload(): Promise<unknown>;
  on(event: "dialog", handler: (dialog: { accept(): Promise<void> }) => void): void;
  on(event: "console", handler: (msg: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", handler: (err: Error) => void): void;
  on(event: "framenavigated", handler: (frame: Frame) => void): void;
}
interface Route {
  request(): { url(): string; method(): string; postData(): string | null };
  fulfill(options: { status: number; contentType?: string; body: string }): Promise<void>;
  abort(): Promise<void>;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  route(url: RegExp, handler: (route: Route) => void): Promise<void>;
  cookies(): Promise<Array<{ name: string; value: string }>>;
}
interface Browser {
  newContext(options?: { viewport?: { width: number; height: number } }): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { channel: string; headless: boolean }): Promise<Browser> };
}

const PC = { viewport: { width: 1280, height: 800 } };
const results: Array<{ ok: boolean; label: string }> = [];
const consoleErrors: string[] = [];
const blockedMailRequests: string[] = [];
const observations: string[] = [];

function check(label: string, ok: boolean) {
  results.push({ ok, label });
  console.log(`${ok ? "✓" : "✗"} ${label}`);
}

function track(page: Page): Page {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const path = page.url().replace(BASE, "");
    const text = msg.text();
    // 想定どおりの応答: 古い・誤ったパスワードでのログイン(400)、使用済みのリンクで開いた再設定の画面
    if (text.includes("status of 400") || text.includes("status of 403")) return;
    // 運営管理は、管理者として使えないセッションに 404 を返す(古いブラウザの確認で想定どおり)
    if (path.startsWith("/ops") && text.includes("status of 404")) return;
    consoleErrors.push(`${path}: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`${page.url().replace(BASE, "")}: (例外) ${err.message.slice(0, 300)}`));
  return page;
}

/** メールを送る要求をブラウザから出させない。/recover は受け止めて、送られた値を返す。 */
async function guardMail(ctx: BrowserContext): Promise<{ recover: () => Record<string, string> | null }> {
  let captured: Record<string, string> | null = null;
  await ctx.route(/\/auth\/v1\/(recover|otp|magiclink|signup|resend|invite)(\?|$)/, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith("/recover") && req.method() === "POST") {
      captured = JSON.parse(req.postData() ?? "{}") as Record<string, string>;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    blockedMailRequests.push(`${req.method()} ${path}`);
    await route.abort();
  });
  return { recover: () => captured };
}

function startServer(): ChildProcess {
  return spawn("npx", ["next", "dev", "-p", String(PORT)], { env: childEnv as NodeJS.ProcessEnv, shell: true, stdio: "ignore" });
}

async function waitForServer() {
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("開発サーバーが起動しませんでした");
}

async function warmUp() {
  for (const path of ["/login", "/forgot-password", "/reset-password", "/signup", "/auth/confirm", "/auth/verify", "/onboarding/salon", "/onboarding/status", "/dashboard", "/ops/salons", "/ops/salons/new"]) {
    await fetch(`${BASE}${path}`, { redirect: "manual" }).catch(() => {});
  }
}

async function waitText(page: Page, value: string | RegExp, timeout = 60_000) {
  try {
    await page.getByText(value).first().waitFor({ timeout });
  } catch {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 500).replace(/\s+/g, " ");
    throw new Error(`「${value}」が表示されません(${page.url()}): ${body}`);
  }
}

async function login(page: Page, email: string, pw: string) {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(pw);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

/** ブラウザの cookie(@supabase/ssr)からセッションを読む(分割・base64 の形に対応)。 */
async function sessionFromCookies(ctx: BrowserContext): Promise<{ access_token: string; refresh_token: string } | null> {
  const key = `sb-${target.ref}-auth-token`;
  const parts = (await ctx.cookies())
    .filter((c) => c.name === key || c.name.startsWith(`${key}.`))
    .sort((a, b) => Number(a.name.split(".").pop()) - Number(b.name.split(".").pop()));
  if (parts.length === 0) return null;
  let raw = parts.map((c) => decodeURIComponent(c.value)).join("");
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8");
  try {
    const s = JSON.parse(raw) as { access_token?: string; refresh_token?: string };
    return s.access_token && s.refresh_token ? { access_token: s.access_token, refresh_token: s.refresh_token } : null;
  } catch {
    return null;
  }
}

async function gotrue(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: init.method ?? "GET",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, code: (json.error_code ?? json.code ?? null) as string | number | null, json };
}

async function passwordGrant(email: string, pw: string) {
  return gotrue("token?grant_type=password", { method: "POST", body: { email, password: pw } });
}

/** 古いトークンで、Supabase Auth・DB(RPC・REST)を直接使えないこと。 */
async function oldTokensRejected(label: string, tokens: { access_token: string; refresh_token: string }, opts: { salonRest?: boolean }) {
  const user = await gotrue("user", { token: tokens.access_token });
  const put = await gotrue("user", { method: "PUT", token: tokens.access_token, body: { password: `Takeover-${randomBytes(6).toString("hex")}9a` } });
  const refresh = await gotrue("token?grant_type=refresh_token", { method: "POST", body: { refresh_token: tokens.refresh_token } });
  const state = await fetch(`${SUPABASE_URL}/rest/v1/rpc/my_account_state`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const stateJson = (await state.json().catch(() => null)) as Array<{ session_trusted?: boolean }> | { session_trusted?: boolean } | null;
  const trusted = Array.isArray(stateJson) ? stateJson[0]?.session_trusted : stateJson?.session_trusted;
  let salonRows = 0;
  if (opts.salonRest) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/salons?select=id`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${tokens.access_token}` } });
    salonRows = r.ok ? ((await r.json()) as unknown[]).length : 0;
  }
  observations.push(
    `${label} 再設定の前のトークン: GET /user=${user.status}(${user.code}) PUT /user=${put.status}(${put.code}) リフレッシュ=${refresh.status}(${refresh.code}) ` +
      `my_account_state=${state.status}・session_trusted=${trusted}${opts.salonRest ? ` / salons=${salonRows}行` : ""}`,
  );
  check(
    `${label}: 再設定の前のセッションは、Auth(参照・パスワードの変更・リフレッシュ)も DB も使えない`,
    user.status >= 400 && put.status >= 400 && refresh.status >= 400 && trusted !== true && salonRows === 0,
  );
}

const newEmail = (tag: string) => `pwreset-${tag}-${Date.now()}-${randomBytes(2).toString("hex")}@example.invalid`;
const newPassword = () => `Reset-${randomBytes(6).toString("hex")}9a`;

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE_PATH ?? "playwright-core";
  const pw = (await import(spec)) as Playwright & { default?: Playwright };
  const playwright: Playwright = pw.chromium ? pw : pw.default!;
  const { default: postgres } = await import("postgres");
  const sql = postgres({ ...databaseOptions(target.testdb), max: 1, onnotice: () => {} });
  await assertTestDatabase(sql, target.ref);
  const { createTestSalon, notificationsTestAdminClient } = await import("./notificationsFixtures");
  const admin = notificationsTestAdminClient();
  const createdUsers: string[] = [];
  const contexts: BrowserContext[] = [];
  let operatorId: string | null = null;
  const server = startServer();
  const browser = await playwright.chromium.launch({ channel, headless: !headed });

  async function newCtx(): Promise<BrowserContext> {
    const ctx = await browser.newContext(PC);
    contexts.push(ctx);
    return ctx;
  }
  async function userIdOf(address: string): Promise<string> {
    const { data } = await admin.rpc("account_lookup_for_signup", { p_email: address });
    return (data as Array<{ user_id: string }>)[0].user_id;
  }
  async function verification(userId: string) {
    const [row] = await sql`
      select v.method, v.verified_session_id, u.email_confirmed_at is not null as confirmed
        from auth.users u left join public.account_verifications v on v.user_id = u.id where u.id = ${userId}`;
    return row as { method: string | null; verified_session_id: string | null; confirmed: boolean };
  }

  /**
   * 既存の画面でパスワードを再設定する(上の説明のとおり、/recover の送信だけを置き換える)。
   * 戻り値: 新しいパスワードと、再設定のリンク・セッションの情報。
   */
  async function resetThroughExistingScreens(label: string, email: string) {
    const ctx = await newCtx();
    const mail = await guardMail(ctx);
    const page = track(await ctx.newPage());
    await page.goto(`${BASE}/login`);
    await page.getByRole("link", { name: "パスワードをお忘れですか？" }).click();
    await page.waitForURL(/\/forgot-password/);
    await page.locator("#email").fill(email);
    await page.getByRole("button", { name: "再設定メールを送る" }).click();
    await waitText(page, "再設定メールを送信しました");
    const req = mail.recover();
    check(
      `${label}: 「再設定メールを送る」は PKCE(code_challenge 付き)の再設定の要求になる(ここで受け止め、メールは送らない)`,
      req?.email === email && typeof req?.code_challenge === "string" && req?.code_challenge_method === "s256",
    );

    // /recover がサーバーで行うことを、メールを送らずに同じ形で用意する
    const userId = await userIdOf(email);
    // GoTrue の FlowState と同じ値(文字列の列は、GoTrue と同じく空文字。null にすると GoTrue が読めない)
    await sql`
      insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type, provider_access_token,
                                   provider_refresh_token, authentication_method, email_optional, created_at, updated_at)
      values (gen_random_uuid(), ${userId}, gen_random_uuid()::text, ${req!.code_challenge_method}::auth.code_challenge_method, ${req!.code_challenge},
              'recovery', '', '', 'recovery', false, now(), now())`;
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "recovery", email });
    if (linkError || !link.properties?.hashed_token) throw new Error(`generateLink(recovery) に失敗: ${linkError?.code}`);
    const hashed = link.properties.hashed_token;
    const token = `pkce_${hashed}`;
    const u = await sql`update auth.users set recovery_token = ${token} where id = ${userId} and recovery_token = ${hashed}`;
    const t = await sql`update auth.one_time_tokens set token_hash = ${token} where user_id = ${userId} and token_type = 'recovery_token' and token_hash = ${hashed}`;
    if (u.count !== 1 || t.count !== 1) throw new Error("再設定のトークンに PKCE の印を付けられませんでした");
    const confirmationUrl = `${SUPABASE_URL}/auth/v1/verify?token=${token}&type=recovery&redirect_to=${BASE}/reset-password`;

    // メールのリンクを開く(GoTrue が検証して、再設定の画面へ code を付けて戻す)
    await page.goto(confirmationUrl);
    await page.waitForURL(/\/reset-password/, { timeout: 60_000 });
    const landed = new URL(page.url());
    const landedWithCode = landed.searchParams.has("code");
    try {
      await page.locator("#password").waitFor({ timeout: 30_000 });
    } catch {
      const errs = [...landed.searchParams.entries(), ...new URLSearchParams(landed.hash.slice(1)).entries()]
        .filter(([k]) => k.startsWith("error"))
        .map(([k, v]) => `${k}=${v}`);
      const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
      throw new Error(`再設定の画面に入力欄が出ません(code=${landedWithCode ? "あり" : "なし"} ${errs.join(" ")}): ${body}`);
    }
    check(`${label}: リンクから再設定の画面へ ?code= で戻り、PKCE の交換のあと新しいパスワードの入力が出る`, landedWithCode);
    const recovery = await sessionFromCookies(ctx);
    const claims = recovery ? decodeJwt(recovery.access_token) : {};
    const amr = Array.isArray(claims.amr) ? (claims.amr as Array<{ method?: string }>).map((a) => a.method) : [];
    const [dbAmr] = recovery
      ? await sql`select array_agg(authentication_method order by created_at) as methods from auth.mfa_amr_claims where session_id = ${String(claims.session_id)}::uuid`
      : [{ methods: null }];
    observations.push(`${label} 再設定のリンクのセッション(PKCE): amr JWT=${JSON.stringify(amr)} / DB=${JSON.stringify(dbAmr?.methods)}`);

    const pwNew = newPassword();
    await page.locator("#password").fill(pwNew);
    await page.locator("#confirm-password").fill(pwNew);
    await page.getByRole("button", { name: "パスワードを再設定する" }).click();
    await page.waitForURL(/\/login\?reset=1/, { timeout: 60_000 });
    await waitText(page, "パスワードを再設定しました。新しいパスワードでログインしてください。");
    const after = await sessionFromCookies(ctx);
    const recoveryUser = recovery ? await gotrue("user", { token: recovery.access_token }) : { status: 0 };
    check(
      `${label}: 保存のあとサインアウトし、ログイン画面(再設定しました)へ進む。再設定のセッションはもう使えない`,
      after === null && recoveryUser.status >= 400,
    );
    return { page, ctx, password: pwNew, confirmationUrl, recoverySessionId: String(claims.session_id ?? ""), amr };
  }

  /** 新しいパスワードでログインし、行き先が expected で、本人確認・登録の画面を行き来しないこと。 */
  async function loginAndExpect(label: string, page: Page, email: string, pw: string, expected: RegExp, detail?: (page: Page) => Promise<boolean>) {
    const navs: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame.parentFrame() === null) navs.push(frame.url().replace(BASE, ""));
    });
    await login(page, email, pw);
    await page.waitForURL(expected, { timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    const settled = expected.test(page.url());
    await page.reload();
    await page.waitForLoadState("networkidle");
    const afterReload = expected.test(page.url());
    const path = (u: string) => u.replace(BASE, "").replace(/[?#].*$/, "");
    // ログインのあとの移動(同じ場所の続き・再読み込みは1つにまとめる)。違う場所を行き来したら「ループ」
    const start = navs.findIndex((u) => path(u) !== "/login");
    const afterLogin = (start === -1 ? [] : navs.slice(start)).map(path).filter((p, i, all) => i === 0 || all[i - 1] !== p);
    const visitedVerify = afterLogin.some((p) => p.startsWith("/auth/verify"));
    const repeats = afterLogin.some((p, i) => afterLogin.indexOf(p) !== i);
    const extra = detail ? await detail(page) : true;
    check(
      `${label}: 新しいパスワードでログインすると ${expected.source.replace(/\\\//g, "/")} に進み、本人確認・登録の画面を行き来しない(再読み込みでも同じ)`,
      settled && afterReload && !visitedVerify && !repeats && extra,
    );
    observations.push(`${label} ログイン後の移動: ${afterLogin.join(" → ") || "(なし)"}`);
  }

  /** 古いパスワードでは、画面からも API からもログインできない。 */
  async function oldPasswordRejected(label: string, email: string, oldPw: string) {
    const api = await passwordGrant(email, oldPw);
    const ctx = await newCtx();
    const page = track(await ctx.newPage());
    await login(page, email, oldPw);
    await waitText(page, "メールアドレスまたはパスワードが正しくありません。");
    const staysOnLogin = page.url().replace(/[?#].*$/, "") === `${BASE}/login`;
    check(`${label}: 古いパスワードでは、画面からも API からもログインできない`, api.status === 400 && api.code === "invalid_credentials" && staysOnLogin);
  }

  /**
   * 再設定の前からログインしていたブラウザは、もう使えない(本人確認の画面に進まない)。
   * お客様の画面はログイン画面に戻す。運営管理(/ops)は、管理者でない・ログインしていないときと同じく 404(0024 からの設計。画面の存在を知らせない)。
   */
  async function oldBrowserSignedOut(label: string, ctx: BrowserContext, path: string, expect: "login" | "not_found" = "login") {
    const page = track(await ctx.newPage());
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle");
    const at = page.url().replace(/[?#].*$/, "");
    const text = await page.locator("body").innerText();
    const ok = expect === "login" ? at === `${BASE}/login` : at === `${BASE}${path}` && text.includes("404") && !text.includes("運営管理");
    check(
      `${label}: 再設定の前からログインしていた別のブラウザは、もう使えない(${expect === "login" ? "ログイン画面に戻る" : "運営管理は 404"})`,
      ok,
    );
  }

  /** 使用済みのリンクは、もう一度使えない(再設定の画面は「無効なリンク」)。 */
  async function usedLinkRejected(label: string, confirmationUrl: string) {
    const ctx = await newCtx();
    await guardMail(ctx);
    const page = track(await ctx.newPage());
    await page.goto(confirmationUrl);
    await page.waitForURL(/\/reset-password/, { timeout: 60_000 });
    const errorCode = /error_code=([a-z_]+)/.exec(page.url())?.[1] ?? null;
    await waitText(page, "リンクの有効期限が切れているか、無効なリンクです。", 20_000);
    check(`${label}: 使った再設定のリンクは、もう一度使えない(${errorCode ?? "エラー"})`, errorCode !== null);
  }

  try {
    await waitForServer();
    await warmUp();
    console.log(`開発サーバー・ブラウザ(${channel}${headed ? "" : "・画面なし"})・テスト用DB(GoTrue v2.197.0)・メールは送らない`);

    // ------------------------------------------------------------------ 準備
    // A. 既存店舗のオーナー(0025 の移行と同じ legacy・無償提供)
    const owner = await createTestSalon({ plan: "salonpack" });
    createdUsers.push(owner.userId);
    // B. 既存の運営管理者(legacy)
    const opEmail = newEmail("ops");
    const opPassword = newPassword();
    const { data: op } = await admin.auth.admin.createUser({ email: opEmail, password: opPassword, email_confirm: true });
    operatorId = op.user!.id;
    createdUsers.push(operatorId);
    await admin.from("account_verifications").insert({ user_id: operatorId, method: "legacy" });
    await admin.from("operator_admins").insert({ user_id: operatorId, granted_by: "password-reset-walkthrough", note: "test" });

    // 再設定の前からのセッション(別の端末): API のトークンと、ログインしたままのブラウザ
    const ownerOldTokens = await passwordGrant(owner.email, owner.password);
    const opOldTokens = await passwordGrant(opEmail, opPassword);
    const ownerOldCtx = await newCtx();
    {
      const page = track(await ownerOldCtx.newPage());
      await login(page, owner.email, owner.password);
      await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
    }
    const opOldCtx = await newCtx();
    const opPage = track(await opOldCtx.newPage());
    opPage.on("dialog", (d) => void d.accept());
    await login(opPage, opEmail, opPassword);
    await opPage.waitForURL(/\/ops\/salons/, { timeout: 60_000 });

    // C1. 新規登録して、メールの確認がまだ
    const c1Email = newEmail("unconfirmed");
    const c1Password = newPassword();
    const c2Email = newEmail("linkonly");
    const c2Password = newPassword();
    for (const [address, pwd] of [
      [c1Email, c1Password],
      [c2Email, c2Password],
    ]) {
      const ctx = await newCtx();
      await guardMail(ctx);
      const page = track(await ctx.newPage());
      await page.goto(`${BASE}/signup`);
      await page.locator("#email").fill(address);
      await page.locator("#password").fill(pwd);
      await page.locator("#passwordConfirm").fill(pwd);
      await page.getByRole("button", { name: "登録して確認メールを受け取る" }).click();
      await waitText(page, "ご入力のメールアドレスでお手続きできる場合は");
      createdUsers.push(await userIdOf(address));
    }
    // C2. 新規登録 → 確認のリンクは開いたが、本人確認(パスワード)の手続きの前に離れた
    const c2Ctx = await newCtx();
    await guardMail(c2Ctx);
    {
      const page = track(await c2Ctx.newPage());
      const { data } = await admin.auth.admin.generateLink({ type: "magiclink", email: c2Email });
      await page.goto(`${BASE}/auth/confirm#token_hash=${data.properties!.hashed_token}&type=magiclink`);
      await page.getByRole("button", { name: /ログインして続ける/ }).click();
      await page.waitForURL(/\/auth\/verify/, { timeout: 60_000 });
      await waitText(page, "登録したパスワード");
    }
    const c2LinkTokens = await sessionFromCookies(c2Ctx);
    // D. 運営が招待したが、招待のリンクを使っていない(利用開始待ちの店舗あり。パスワードは無い)
    const dEmail = newEmail("invited");
    await opPage.goto(`${BASE}/ops/salons/new`);
    await opPage.locator("#draft-name").fill("再設定で受け取るサロン");
    await opPage.locator("#draft-contactName").fill("招待 四郎");
    await opPage.locator("#draft-loginEmail").fill(dEmail);
    await opPage.locator("#draft-plan").selectOption("reviews");
    await opPage.locator("label", { hasText: "利用開始待ち" }).locator("input[type=radio]").check();
    await opPage.getByRole("button", { name: /内容を確認/ }).click();
    await opPage.getByRole("dialog").waitFor({ timeout: 60_000 });
    await opPage.getByRole("button", { name: "登録して招待メールを送信" }).click();
    await opPage.waitForURL(/\/ops\/salons\/[0-9a-f-]{36}\?registered=/, { timeout: 60_000 });
    createdUsers.push(await userIdOf(dEmail));

    // ------------------------------------------------------------------ A. 既存店舗のオーナー
    {
      const r = await resetThroughExistingScreens("既存店舗のオーナー", owner.email);
      await loginAndExpect("既存店舗のオーナー", r.page, owner.email, r.password, /\/dashboard/, async (p) => !p.url().includes("/onboarding"));
      const v = await verification(owner.userId);
      check("既存店舗のオーナー: 本人確認の記録は legacy のまま(再設定で書き換えない)", v.method === "legacy");
      await oldPasswordRejected("既存店舗のオーナー", owner.email, owner.password);
      await oldTokensRejected("既存店舗のオーナー", ownerOldTokens.json as { access_token: string; refresh_token: string }, { salonRest: true });
      await oldBrowserSignedOut("既存店舗のオーナー", ownerOldCtx, "/dashboard");
      await usedLinkRejected("既存店舗のオーナー", r.confirmationUrl);
    }

    // ------------------------------------------------------------------ B. 既存の運営管理者
    {
      const r = await resetThroughExistingScreens("既存の運営管理者", opEmail);
      await loginAndExpect("既存の運営管理者", r.page, opEmail, r.password, /\/ops\/salons/, async (p) => (await p.locator("body").innerText()).includes("運営管理"));
      const v = await verification(operatorId);
      check("既存の運営管理者: 本人確認の記録は legacy のまま", v.method === "legacy");
      await oldPasswordRejected("既存の運営管理者", opEmail, opPassword);
      await oldTokensRejected("既存の運営管理者", opOldTokens.json as { access_token: string; refresh_token: string }, {});
      await oldBrowserSignedOut("既存の運営管理者", opOldCtx, "/ops/salons", "not_found");
    }

    // ------------------------------------------------------------------ C1. 新規登録・メール未確認
    {
      const id = await userIdOf(c1Email);
      const before = await verification(id);
      const r = await resetThroughExistingScreens("新規(メール未確認)", c1Email);
      const v = await verification(id);
      check(
        "新規(メール未確認): 再設定のリンクでメールが確認済みになり、本人確認(password_set・再設定のセッション)を記録する",
        !before.confirmed && before.method === null && v.confirmed && v.method === "password_set" && v.verified_session_id === r.recoverySessionId,
      );
      await loginAndExpect("新規(メール未確認)", r.page, c1Email, r.password, /\/onboarding\/salon/);
      await oldPasswordRejected("新規(メール未確認)", c1Email, c1Password);
    }

    // ------------------------------------------------------------------ C2. 新規登録・リンクは開いたが本人確認の前
    {
      const id = await userIdOf(c2Email);
      const before = await verification(id);
      const r = await resetThroughExistingScreens("新規(本人確認の前)", c2Email);
      const v = await verification(id);
      check(
        "新規(本人確認の前): 本人確認(password_set)を、再設定のセッションで記録する(先に開いた確認のリンクのセッションではない)",
        before.confirmed && before.method === null && v.method === "password_set" && v.verified_session_id === r.recoverySessionId,
      );
      await loginAndExpect("新規(本人確認の前)", r.page, c2Email, r.password, /\/onboarding\/salon/);
      await oldPasswordRejected("新規(本人確認の前)", c2Email, c2Password);
      if (c2LinkTokens) await oldTokensRejected("新規(本人確認の前)", c2LinkTokens, { salonRest: true });
      else check("新規(本人確認の前): 確認のリンクのセッションを読み取れる", false);
      await oldBrowserSignedOut("新規(本人確認の前)", c2Ctx, "/auth/verify");
    }

    // ------------------------------------------------------------------ D. 運営の招待・招待を使っていない
    {
      const id = await userIdOf(dEmail);
      const before = await verification(id);
      const r = await resetThroughExistingScreens("運営の招待(未使用)", dEmail);
      const v = await verification(id);
      check(
        "運営の招待(未使用): 再設定でメール確認・本人確認(password_set)が済む",
        !before.confirmed && before.method === null && v.confirmed && v.method === "password_set" && v.verified_session_id === r.recoverySessionId,
      );
      await loginAndExpect(
        "運営の招待(未使用)",
        r.page,
        dEmail,
        r.password,
        /\/onboarding\/status/,
        async (p) => (await p.locator("#profile-name").inputValue()) === "再設定で受け取るサロン",
      );
      // 運営の詳細の「招待と案内」が使う値でも、本人確認が済んだ扱いになる(画面の表示は onboarding-walkthrough で確認済み)
      const { data: salon } = await admin.from("salons").select("id").eq("name", "再設定で受け取るサロン").order("created_at", { ascending: false }).limit(1).single();
      const { data: ob } = await admin.rpc("admin_salon_onboarding", { p_salon_id: salon!.id });
      const row = (Array.isArray(ob) ? ob[0] : ob) as { owner_verified?: boolean; owner_verification_method?: string } | null;
      check("運営の招待(未使用): 運営の記録でも「招待手続き完了(本人がパスワードを設定)」になる", row?.owner_verified === true && row?.owner_verification_method === "password_set");
    }
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    if (operatorId) await admin.from("salon_drafts").delete().eq("created_by", operatorId);
    if (createdUsers.length > 0) await sql`delete from auth.flow_state where user_id = any(${createdUsers}::uuid[])`.catch(() => undefined);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    await sql.end().catch(() => undefined);
    await browser.close().catch(() => undefined);
    // Windows では先にシェルを止めると next dev が残るため、プロセスの木ごと止める
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill();
  }
  console.log("\n[観察した値]");
  for (const o of observations) console.log(`  ${o}`);
  check(`ブラウザからメールを送る要求(/recover 以外)は出ていない${blockedMailRequests.length ? `: ${blockedMailRequests.join(", ")}` : ""}`, blockedMailRequests.length === 0);
  if (consoleErrors.length > 0) {
    console.log("\nブラウザのコンソールのエラー:");
    for (const e of consoleErrors) console.log(`  ${e}`);
  }
  check("ブラウザのコンソールにエラー・例外が出ない", consoleErrors.length === 0);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 件 OK`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`止めました: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
