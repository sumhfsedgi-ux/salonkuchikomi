/**
 * 新規登録・運営によるサロン登録と招待・利用区分の、実際のブラウザでの通しの確認(テスト用 DB。0025・0026)。
 * 開発サーバーをテスト用 DB の設定で起動し(SALONPACK_VERIFY_MODE=testdb: 認証のメールは送らない)、
 * 端末にインストール済みの Chrome を playwright-core で操作する。メールのリンクの代わりに、メールを送らない
 * admin.generateLink のトークンで /auth/confirm を開く。アドレスはすべて example.invalid(届かない予約のドメイン)。
 * 既存のパスワード再設定は scripts/testdb/password-reset-walkthrough.ts で確かめる。
 *
 * 2つの流れを分けて確かめる(0026):
 *   開いた状態(既定): 新規登録の受付を開く(アプリの SELF_SIGNUP_ENABLED=1 と、DB の self_signup_settings.open)。
 *     お客様自身の新規登録・待ち時間・運営の登録(登録種別・案内予定のプラン)・テスト用の指定・止めている既存の店舗の調整
 *   閉じた状態(--closed): 新規登録の受付を閉じる(本番の今と同じ)。受付停止の案内・RPC の直接の呼び出し・
 *     運営の招待を最後まで(招待の再送・古いリンクからのやり直しを含む)
 * DB の受付の設定は、変える前の値を記録し、終わったとき・失敗したときに必ず元に戻す(scripts/testdb/signupSetting.ts)。
 * 作ったアカウント・店舗・下書き・擬似の Google アカウントは、終わったときに消す(もとからある店舗には触れない)。
 *
 *   npm i --no-save playwright-core
 *   npx tsx scripts/testdb/onboarding-walkthrough.ts [--closed] [--channel=chrome|msedge] [--headed]
 * スクリーンショットは ONBOARDING_WALKTHROUGH_SHOTS(省略時は保存しない)。
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { buildChildEnv, loadTestTarget } from "./target.mjs";

const closedMode = process.argv.includes("--closed");
// 起動済みの開発サーバー(テスト用 DB の設定で起動したもの)を使うときは ONBOARDING_WALKTHROUGH_BASE に URL を入れる(起動も停止もしない)
const reuseBase = process.env.ONBOARDING_WALKTHROUGH_BASE ?? null;
const PORT = reuseBase ? Number(new URL(reuseBase).port) : 3996;
const BASE = reuseBase ?? `http://localhost:${PORT}`;
const channel = process.argv.find((a) => a.startsWith("--channel="))?.split("=")[1] ?? "chrome";
const headed = process.argv.includes("--headed");
const shotsDir = process.env.ONBOARDING_WALKTHROUGH_SHOTS ?? null;

const target = loadTestTarget({ requireDatabaseUrl: true });
const childEnv = buildChildEnv(target, process.env, PORT) as Record<string, string>;
childEnv.NEXT_PUBLIC_APP_MODE = "salonpack";
// 閉じた状態では、アプリの設定も閉じる(本番の今と同じ)
childEnv.SELF_SIGNUP_ENABLED = closedMode ? "" : "1";
for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;

interface Locator {
  click(): Promise<void>;
  check(): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  isDisabled(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  first(): Locator;
  nth(index: number): Locator;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
  selectOption(value: string): Promise<unknown>;
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
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  reload(): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  on(event: "dialog", handler: (dialog: { accept(): Promise<void> }) => void): void;
  on(event: "console", handler: (msg: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", handler: (err: Error) => void): void;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(options?: { viewport?: { width: number; height: number }; isMobile?: boolean; hasTouch?: boolean }): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { channel: string; headless: boolean }): Promise<Browser> };
}

const PC = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

const results: Array<{ ok: boolean; label: string }> = [];
const consoleErrors: string[] = [];

/** ブラウザのコンソールのエラーと、画面の例外を集める(最後に出す)。 */
function track(page: Page): Page {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const path = page.url().replace(BASE, "");
    const text = msg.text();
    // 確認の前のログインで、Supabase がパスワードのログインを 400(email_not_confirmed)で断る。想定どおりの応答
    if (path === "/login" && text.includes("status of 400")) return;
    // 古い招待のリンク(再送で無効になったもの)を開いたとき、Supabase が検証を 403 で断る。想定どおりの応答
    if (path.startsWith("/auth/confirm") && /status of (403|401)/.test(text)) return;
    // スクリーンショットのとき、Playwright が入力欄に caret-color を付ける(カーソルを隠す)。ハイドレーションの前だと不一致になる。
    // 画面の不具合ではないため、スクリーンショットを撮るときの、この属性だけの不一致は数えない
    if (shotsDir && /hydrat/i.test(text) && text.includes('caret-color:"transparent"') && !/^[+-]\s{2,}(?!.*caret-color).*$/m.test(text)) return;
    consoleErrors.push(`${path}: ${/hydrat/i.test(text) ? text.slice(0, 6000) : text.slice(0, 300)}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`${page.url().replace(BASE, "")}: (例外) ${err.message.slice(0, 300)}`));
  return page;
}
function check(label: string, ok: boolean) {
  results.push({ ok, label });
  console.log(`${ok ? "✓" : "✗"} ${label}`);
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
  for (const path of ["/login", "/signup", "/auth/confirm", "/auth/verify", "/onboarding/salon", "/onboarding/status", "/dashboard", "/ops/salons", "/ops/salons/new"]) {
    await fetch(`${BASE}${path}`, { redirect: "manual" }).catch(() => {});
  }
}

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.screenshot({ path: `${shotsDir}/${closedMode ? "closed" : "open"}-${name}.png`, fullPage: true });
}

async function waitText(page: Page, value: string | RegExp, timeout = 60_000) {
  try {
    await page.getByText(value).first().waitFor({ timeout });
  } catch {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 500).replace(/\s+/g, " ");
    throw new Error(`「${value}」が表示されません(${page.url()}): ${body}`);
  }
}

async function body(page: Page): Promise<string> {
  return page.locator("body").innerText();
}

/** 横にはみ出していない(スマートフォンの幅で、横スクロールが出ない)。 */
async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function passwordLogin(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

const email = (tag: string) => `onb-walk-${tag}-${Date.now()}-${randomBytes(2).toString("hex")}@example.invalid`;
const password = () => `Walk-${randomBytes(6).toString("hex")}9a`;
/** 承認・未実装の通知を約束する言葉(画面に出さない)。 */
const PROMISES = /承認|利用開始のご案内|ご案内をお送り|運営で内容を確認|運営が利用開始/;

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE_PATH ?? "playwright-core";
  const pw = (await import(spec)) as Playwright & { default?: Playwright };
  const playwright: Playwright = pw.chromium ? pw : pw.default!;
  const { browserClient, createTestSalon, notificationsTestAdminClient } = await import("./notificationsFixtures");
  const { overrideSignupSetting } = await import("./signupSetting");
  const admin = notificationsTestAdminClient();
  const createdUsers: string[] = [];
  const createdGoogleAccounts: string[] = [];
  let operatorId: string | null = null;
  let restoreSignup: (() => Promise<void>) | null = null;
  const server = reuseBase ? null : startServer();
  const browser = await playwright.chromium.launch({ channel, headless: !headed });

  async function linkFor(type: "magiclink" | "invite", address: string): Promise<string> {
    const { data, error } = await admin.auth.admin.generateLink({ type, email: address });
    if (error || !data.properties?.hashed_token) throw new Error(`generateLink(${type}) に失敗: ${error?.code}`);
    return `${BASE}/auth/confirm#token_hash=${data.properties.hashed_token}&type=${type}`;
  }
  async function userIdOf(address: string): Promise<string> {
    const { data } = await admin.rpc("account_lookup_for_signup", { p_email: address });
    return (data as Array<{ user_id: string }>)[0].user_id;
  }
  async function salonRow(salonId: string) {
    const { data } = await admin.from("salons").select("plan, plan_placeholder, service_status, registration_source").eq("id", salonId).single();
    return data as { plan: string; plan_placeholder: boolean; service_status: string; registration_source: string };
  }
  /** 利用区分が保存されるまで待つ(DB の値で確かめる)。 */
  async function waitStatus(salonId: string, status: string) {
    for (let i = 0; i < 60; i++) {
      if ((await salonRow(salonId)).service_status === status) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`利用区分が ${status} になりません(${salonId})`);
  }
  async function entitlementVersion(salonId: string): Promise<number> {
    const { data } = await admin.from("salon_entitlement_state").select("version").eq("salon_id", salonId).maybeSingle();
    return Number((data as { version?: number } | null)?.version ?? 0);
  }
  async function allowed(salonId: string, feature: string): Promise<boolean> {
    const { data } = await admin.rpc("salon_feature_access", { p_salon_id: salonId, p_feature_key: feature });
    return ((data as Array<{ allowed: boolean }> | null) ?? [])[0]?.allowed === true;
  }
  /** 運営のアカウント(本人確認済み・管理者)。 */
  async function createOperatorAccount(): Promise<{ email: string; password: string }> {
    const opEmail = email("ops");
    const opPassword = password();
    const { data: op } = await admin.auth.admin.createUser({ email: opEmail, password: opPassword, email_confirm: true });
    createdUsers.push(op.user!.id);
    operatorId = op.user!.id;
    await admin.from("account_verifications").insert({ user_id: op.user!.id, method: "legacy" });
    await admin.from("operator_admins").insert({ user_id: op.user!.id, granted_by: "onboarding-walkthrough", note: "test" });
    return { email: opEmail, password: opPassword };
  }
  /** 運営の画面で、通常登録の店舗を登録して招待する(戻り値: 店舗の ID)。 */
  async function registerByOperator(opPage: Page, params: { name: string; invitee: string; plan: "" | "reviews" | "salonpack" }): Promise<string> {
    await opPage.goto(`${BASE}/ops/salons/new`);
    await opPage.locator("#draft-name").fill(params.name);
    await opPage.locator("#draft-contactName").fill("担当 次郎");
    await opPage.locator("#draft-loginEmail").fill(params.invitee);
    if (params.plan) await opPage.locator("#draft-plan").selectOption(params.plan);
    await opPage.getByRole("button", { name: /内容を確認/ }).click();
    await opPage.getByRole("dialog").waitFor({ timeout: 60_000 });
    await opPage.getByRole("button", { name: "登録して招待メールを送信" }).click();
    await opPage.waitForURL(/\/ops\/salons\/[0-9a-f-]{36}\?registered=/, { timeout: 60_000 });
    createdUsers.push(await userIdOf(params.invitee));
    return opPage.url().match(/salons\/([0-9a-f-]{36})/)![1];
  }

  // もとからある店舗(この確認の前から DB にある店舗)。区分・利用可否が変わらないことを最後に確かめる
  const { data: before } = await admin.from("salons").select("id, name, plan, service_status, registration_source");
  const originalSalons = (before ?? []) as Array<{ id: string; name: string; plan: string; service_status: string; registration_source: string }>;
  const originalAccess = new Map<string, boolean>();
  for (const s of originalSalons) originalAccess.set(s.id, await allowed(s.id, "reviews"));

  try {
    // DB の新規登録の受付(変える前の値を記録し、finally で戻す)
    const signup = await overrideSignupSetting(admin, !closedMode);
    restoreSignup = signup.restore;
    await waitForServer();
    await warmUp();
    console.log(
      `開発サーバー・ブラウザ(${channel}${headed ? "" : "・画面なし"})・テスト用DB・認証メールは送らない(検証モード)・新規登録の受付: ${closedMode ? "閉じた状態" : "開いた状態"}`,
    );
    for (const s of originalSalons.filter((x) => x.service_status !== "pending")) {
      check(`もとからある店舗「${s.name}」(${s.registration_source}・${s.service_status}): 口コミを使える`, originalAccess.get(s.id) === true);
    }

    if (closedMode) await closedFlow();
    else await openFlow();
  } finally {
    if (operatorId) await admin.from("salon_drafts").delete().eq("created_by", operatorId);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    for (const id of createdGoogleAccounts) await admin.from("google_accounts").delete().eq("id", id);
    if (restoreSignup) await restoreSignup().catch((e) => console.error(`受付の設定を戻せませんでした: ${e instanceof Error ? e.message : e}`));
    await browser.close().catch(() => undefined);
    // Windows では先にシェルを止めると next dev が残るため、プロセスの木ごと止める
    if (server && process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server?.kill();
  }
  // もとからある店舗は、区分・利用可否が変わっていない(この確認では触れない)
  const { data: after } = await admin.from("salons").select("id, plan, service_status, registration_source").in("id", originalSalons.map((s) => s.id));
  const unchanged =
    (after ?? []).length === originalSalons.length &&
    originalSalons.every((s) => {
      const a = (after ?? []).find((x) => x.id === s.id);
      return a && a.plan === s.plan && a.service_status === s.service_status && a.registration_source === s.registration_source;
    });
  let accessSame = true;
  for (const s of originalSalons) accessSame &&= (await allowed(s.id, "reviews")) === originalAccess.get(s.id);
  check(`もとからある店舗(${originalSalons.length} 件)は、削除・区分の変更をしていない。利用可否も同じ`, unchanged && accessSame);
  if (consoleErrors.length > 0) {
    console.log("\nブラウザのコンソールのエラー:");
    for (const e of consoleErrors) console.log(`  ${e}`);
  }
  check("ブラウザのコンソールにエラー・例外が出ない", consoleErrors.length === 0);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 件 OK`);
  if (failed.length) process.exitCode = 1;

  // ================================================================== 開いた状態
  async function openFlow() {
    // ---------------------------------------------------------------- 1. お客様自身の新規登録・待ち時間
    const ownerEmail = email("self");
    const ownerPassword = password();
    {
      const ctx = await browser.newContext(PC);
      const page = track(await ctx.newPage());
      page.on("dialog", (d) => void d.accept());
      await page.goto(`${BASE}/login`);
      check("ログイン画面に「初めての方はこちら/新規登録」がある", (await body(page)).includes("初めての方はこちら") && (await page.getByRole("link", { name: "新規登録" }).count()) === 1);
      await page.getByRole("link", { name: "新規登録" }).click();
      await page.waitForURL(/\/signup/);
      const pre = await body(page);
      check("新規登録(入力前): 見出し「新規登録」と説明。承認・利用開始のご案内を約束しない", pre.includes("メールアドレスとパスワードを登録してください。") && !PROMISES.test(pre));
      await page.locator("#email").fill("bad");
      await page.locator("#password").fill("short");
      await page.locator("#passwordConfirm").fill("short");
      await page.getByRole("button", { name: "登録して確認メールを受け取る" }).click();
      await waitText(page, "8文字以上で入力してください");
      check("新規登録: 誤りは欄の近くに出し、aria-invalid を付ける", (await page.locator("#password").getAttribute("aria-invalid")) === "true");
      await page.locator("#email").fill(ownerEmail);
      await page.locator("#password").fill(ownerPassword);
      await page.locator("#passwordConfirm").fill(ownerPassword);
      await page.getByRole("button", { name: "登録して確認メールを受け取る" }).click();
      await waitText(page, "登録リクエストを受け付けました");
      const sent = await body(page);
      check(
        "新規登録の送信のあと(検証モード): 「実際のメールは送信していません」を1か所で出し、メールが届く前提の案内を出さない",
        sent.includes("現在は検証モードのため、実際のメールは送信していません。") &&
          sent.includes(`入力したメールアドレス\n${ownerEmail}`) &&
          /再送処理の確認まであと[0-9分秒]+/.test(sent) &&
          !/メールアドレスとパスワードを登録してください|確認メールをご確認ください|お送りし|リンク|迷惑メール/.test(sent),
      );
      await shot(page, "01-signup-sent");
      createdUsers.push(await userIdOf(ownerEmail));

      // 入力し直す: 同じアドレスなら待ち時間が続き(押せない)、別のアドレスなら押せる
      await page.getByRole("button", { name: "メールアドレスを入力し直す" }).click();
      await waitText(page, "メールアドレスとパスワードを登録してください。");
      const submit = page.locator("form button[type=submit]");
      const sameLabel = await submit.innerText();
      check("入力し直す(同じアドレス): 登録のボタンは押せず、サーバーが決めた残りの秒数を出す", (await submit.isDisabled()) && /あと[0-9分秒]+で送信できます/.test(sameLabel));
      await shot(page, "02-signup-reenter-wait");
      await page.locator("#email").fill(email("other"));
      check("入力し直す(別のアドレス): その操作に当てはまる待ちは無く、押せる", !(await submit.isDisabled()) && (await submit.innerText()).includes("登録して確認メールを受け取る"));
      await page.locator("#email").fill(ownerEmail);
      check("同じアドレスに戻すと、また待ち時間を出す", (await submit.isDisabled()) && /あと[0-9分秒]+で送信できます/.test(await submit.innerText()));

      // 確認の前にログインすると、確認が済んでいないことを案内する。再送はサーバーの間隔に従って待つ(画面を移っても同じ)
      await passwordLogin(page, ownerEmail, ownerPassword);
      await waitText(page, "メールアドレスの確認が済んでいません");
      const loginResend = page.getByRole("button", { name: "確認のメールを再送する" });
      check("確認の前のログイン: 確認のメールの再送を出す", (await loginResend.count()) === 1);
      await loginResend.click();
      await waitText(page, "短い間に操作が続いています");
      const waitingLabel = await page.locator("button", { hasText: /再送まであと/ }).first().innerText();
      check(
        "ログイン画面の再送: 新規登録の直後は、同じアドレスの間隔の中なので送らず、残りの秒数を出して押せない",
        /再送まであと[0-9分秒]+/.test(waitingLabel) && (await page.locator("button", { hasText: /再送まであと/ }).first().isDisabled()),
      );
      await shot(page, "03-login-resend-wait");

      // 確認のリンク(メールの代わり)→ ボタンを押す前は「確認しました」と書かない → 本人確認(登録したパスワード)
      await page.goto(await linkFor("magiclink", ownerEmail));
      await waitText(page, "下のボタンを押すと");
      const confirmText = await body(page);
      check("確認のリンク: ボタンを押す前は「確認しました」と書かず、押すと何が起きるかを書く", page.url().endsWith("/auth/confirm") && !confirmText.includes("確認しました"));
      await page.getByRole("button", { name: /ログインして続ける/ }).click();
      await page.waitForURL(/\/auth\/verify/, { timeout: 60_000 });
      await waitText(page, "登録したパスワードを入力してください");
      check("パスワードの画面: 見出しで必要な操作を伝える(「登録したパスワードを入力してください」)", true);
      await shot(page, "04-verify-confirm");
      await page.locator("#verify-password").fill("wrong-password-1");
      await page.getByRole("button", { name: "確認して続ける" }).click();
      await waitText(page, "パスワードが一致しません");
      await page.getByRole("button", { name: "新しいパスワードを設定する" }).click();
      await waitText(page, "パスワードを設定してください");
      check("パスワードの画面: 切り替えると見出しも「パスワードを設定してください」に変わる", true);
      await page.getByRole("button", { name: "登録したパスワードを入力する" }).click();
      await page.locator("#verify-password").fill(ownerPassword);
      await page.getByRole("button", { name: "確認して続ける" }).click();
      await page.waitForURL(/\/onboarding\/salon/, { timeout: 60_000 });
      check("本人確認のあと、店舗の情報の入力へ進む", true);
      await ctx.close();
    }
    // 途中で離れたあと、もう一度ログインすると、店舗の情報の入力から再開する
    let selfSalonId: string;
    {
      const ctx = await browser.newContext(PC);
      const page = track(await ctx.newPage());
      await passwordLogin(page, ownerEmail, ownerPassword);
      await page.waitForURL(/\/onboarding\/salon/, { timeout: 60_000 });
      const form = await body(page);
      check("再ログイン: 店舗の情報から再開する。承認・利用開始のご案内を約束しない", form.includes("店舗の情報を入力してください") && !PROMISES.test(form));
      await page.getByRole("button", { name: "店舗を登録する" }).click();
      await waitText(page, "サロン名を入力してください");
      await page.locator("#profile-name").fill("ウォークスルーのサロン");
      await page.locator("#profile-contactName").fill("確認 太郎");
      await page.locator("#profile-contactPhone").fill("０３－１２３４－５６７８");
      await page.getByRole("button", { name: "店舗を登録する" }).click();
      await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      const status = await body(page);
      check(
        "店舗の登録のあと: 「店舗情報の登録が完了しました」「プラン選択・お支払いの手続きを準備しています」。承認・ご案内を約束しない",
        status.includes("店舗情報の登録が完了しました") &&
          status.includes("現在、プラン選択・お支払いの手続きを準備しています") &&
          status.includes("ご契約・お支払いは、まだ発生していません") &&
          !PROMISES.test(status) &&
          !/口コミプラン|契約プラン|案内予定のプラン/.test(status),
      );
      await shot(page, "05-status-pending");
      const { data: salon } = await admin
        .from("salons")
        .select("id, slug, plan_placeholder, service_status, registration_source, contact_phone")
        .eq("name", "ウォークスルーのサロン")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      selfSalonId = salon!.id;
      check(
        "お客様の店舗: 利用開始待ち・プラン未定(仮の値)・お客様による登録。電話番号は半角にそろう",
        salon?.service_status === "pending" && salon?.plan_placeholder === true && salon?.registration_source === "self_signup" && salon?.contact_phone === "03-1234-5678",
      );
      for (const path of ["/dashboard", "/dashboard/reviews", "/dashboard/settings", "/dashboard/setup/reviews"]) {
        await page.goto(`${BASE}${path}`);
        await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      }
      check("登録しただけでは使えない: ダッシュボードの各画面に直接アクセスしても、利用開始待ちの画面に戻る", true);
      const pub = await fetch(`${BASE}/review/${salon!.slug}`).then((r) => r.text());
      check("登録しただけでは使えない: お客様用ページは「現在ご利用いただけません」", pub.includes("現在ご利用いただけません"));
      const gen = await fetch(`${BASE}/api/generate-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salonId: salon!.id, answers: [] }),
      });
      check("登録しただけでは使えない: 生成 API は 403", gen.status === 403);
      await page.goto(`${BASE}/onboarding/status`);
      await page.locator("#profile-contactName").fill("確認 花子");
      await page.getByRole("button", { name: "登録内容を保存する" }).click();
      await waitText(page, "登録内容を保存しました");
      check("利用開始待ち: 登録内容を確認・修正できる", true);
      await ctx.close();
    }
    {
      const ctx = await browser.newContext(PHONE);
      const page = track(await ctx.newPage());
      await page.goto(`${BASE}/signup`);
      const signupOk = await noHorizontalOverflow(page);
      await passwordLogin(page, ownerEmail, ownerPassword);
      await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      check("スマートフォンの幅: 新規登録・利用開始待ちの画面が横にはみ出さない", signupOk && (await noHorizontalOverflow(page)));
      await shot(page, "06-status-phone");
      await ctx.close();
    }

    // ---------------------------------------------------------------- 2. 運営によるサロンの追加(登録種別・案内予定のプラン)
    const op = await createOperatorAccount();
    const invitee = email("invitee");
    const opCtx = await browser.newContext(PC);
    const opPage = track(await opCtx.newPage());
    opPage.on("dialog", (d) => void d.accept());
    await passwordLogin(opPage, op.email, op.password);
    await opPage.waitForURL(/\/ops\/salons/, { timeout: 60_000 });
    await opPage.getByRole("link", { name: "サロンを追加" }).click();
    await opPage.waitForURL(/\/ops\/salons\/new/);
    const kindRadio = (label: string) => opPage.locator("label", { hasText: label }).locator("input[type=radio]");
    {
      const form = await body(opPage);
      check(
        "サロンを追加: 登録種別は「通常登録」「テスト用」だけ(無料提供は選べない)。運営の承認・利用開始のご案内を約束しない",
        form.includes("登録種別とプラン") &&
          (await kindRadio("通常登録").count()) === 1 &&
          (await kindRadio("テスト用").count()) === 1 &&
          (await kindRadio("無料提供").count()) === 0 &&
          form.includes("登録しただけでは、サービスの機能は使えません(プラン選択・お支払いの手続きは準備中です)") &&
          !PROMISES.test(form),
      );
      check("サロンを追加: 新しい下書きは「通常登録」が初期選択", (await kindRadio("通常登録").isChecked()) && !(await kindRadio("テスト用").isChecked()));
      check(
        "通常登録のプランは「案内予定のプラン(任意)」で「未定」を選べる(契約ではないと書く)",
        form.includes("案内予定のプラン") && form.includes("契約ではありません") && (await opPage.locator('#draft-plan option[value=""]').innerText()) === "未定",
      );
      await kindRadio("テスト用").check();
      check("テスト用のプランは「契約プラン(必須)」", (await body(opPage)).includes("テスト用の店舗の本登録に必要です"));
      await kindRadio("通常登録").check();
    }
    await opPage.locator("#draft-name").fill("運営が追加するサロン");
    await opPage.getByRole("button", { name: "下書きを保存" }).click();
    await opPage.waitForURL(/\/ops\/salons\/drafts\//, { timeout: 60_000 });
    await waitText(opPage, "下書きを保存しました");
    check("サロンを追加: サロン名だけで下書きを保存できる(アカウント・店舗・メールは作らない)", (await userIdOf(invitee).catch(() => null)) === null);
    await kindRadio("テスト用").check();
    await opPage.getByRole("button", { name: "下書きを保存" }).click();
    await waitText(opPage, "下書きを保存しました");
    await opPage.reload();
    await opPage.locator("#draft-name").waitFor({ timeout: 60_000 });
    check("保存済みの下書き: 開き直しても、保存した登録種別(テスト用)のまま", (await kindRadio("テスト用").isChecked()) && !(await kindRadio("通常登録").isChecked()));
    await kindRadio("通常登録").check();
    await opPage.locator("#draft-plan").selectOption("reviews");
    const blogSwitch = opPage.getByRole("switch", { name: "ブログの利用を許可する" });
    check("口コミプランのブログは「プラン対象外」と表示し、スイッチを押せない", (await blogSwitch.isDisabled()) && (await body(opPage)).includes("プラン対象外"));
    await opPage.locator("#draft-plan").selectOption("salonpack");
    await opPage.locator("#draft-contactName").fill("担当 次郎");
    await opPage.locator("#draft-loginEmail").fill(invitee);
    await opPage.getByRole("button", { name: /内容を確認/ }).click();
    await opPage.getByRole("dialog").waitFor({ timeout: 60_000 });
    const confirmDialog = await opPage.getByRole("dialog").innerText();
    check(
      "確認画面(通常登録): 案内予定のプランは「契約ではありません」と出し、登録しただけでは使えないことを出す。運営が利用開始するとは書かない",
      /案内予定のプラン\s*SalonPack\(契約ではありません\)/.test(confirmDialog) &&
        confirmDialog.includes("利用を始めたときに使える機能(予定)") &&
        confirmDialog.includes("登録しただけでは、サービスの機能は使えません") &&
        confirmDialog.includes("利用には、担当者の招待・本人確認の手続きの完了が必要です") &&
        !PROMISES.test(confirmDialog),
    );
    await shot(opPage, "07-ops-confirm");
    await opPage.getByRole("button", { name: "登録して招待メールを送信" }).click();
    await opPage.waitForURL(/\/ops\/salons\/[0-9a-f-]{36}\?registered=/, { timeout: 60_000 });
    await waitText(opPage, "検証モードのため、案内のメールは送信していません");
    const salonId = opPage.url().match(/salons\/([0-9a-f-]{36})/)![1];
    createdUsers.push(await userIdOf(invitee));
    {
      const detail = await body(opPage);
      check(
        "本登録のあと(詳細): 「案内予定のプラン SalonPack(契約ではありません)」。契約と利用許可は読み取りだけ(現在の契約とは出さない)",
        detail.includes("案内予定のプラン SalonPack(契約ではありません)") &&
          detail.includes("利用開始待ちのため、契約プランはまだありません") &&
          !detail.includes("(現在の契約)") &&
          !detail.includes("通常登録"),
      );
      const statusOptions = opPage.locator("#service");
      check(
        "利用区分の変更(新しい店舗・利用開始待ち): 「テスト用に変更」だけ。無料提供は出さない",
        (await statusOptions.locator("label", { hasText: "テスト用に変更" }).count()) === 1 && (await statusOptions.locator("label", { hasText: "無料提供" }).count()) === 0,
      );
      check("招待の再送: 60秒たつまで押せない", await opPage.getByRole("button", { name: /再送/ }).isDisabled());
      await shot(opPage, "08-ops-detail-pending");
    }
    const row0 = await salonRow(salonId);
    check("本登録: 通常登録は利用開始待ち(pending)・プランは予定(仮の値ではない)", row0.service_status === "pending" && row0.plan === "salonpack" && !row0.plan_placeholder);

    // 新しい店舗を「お客様登録・無料提供」と同じ状態にできない(DB の関数でも断る)
    {
      const { data: draftRes } = await admin.rpc("admin_save_salon_draft", {
        p_actor_user_id: operatorId,
        p_draft_id: null,
        p_expected_version: null,
        p_fields: { name: "無料提供の下書き", service_status: "complimentary" },
      });
      const { data: statusRes } = await admin.rpc("admin_update_salon_service_status", {
        p_actor_user_id: operatorId,
        p_salon_id: salonId,
        p_expected_version: await entitlementVersion(salonId),
        p_expected_status: "pending",
        p_new_status: "complimentary",
        p_note: null,
        p_request_id: randomUUID(),
      });
      check(
        "新しい店舗は無料提供にできない(下書きの保存も、利用区分の変更も DB が断る)",
        (draftRes as { result: string }).result === "invalid:service_status" &&
          (statusRes as { result: string; detail?: string }).detail === "complimentary_existing_only" &&
          (await salonRow(salonId)).service_status === "pending",
      );
    }

    // 招待された本人: 招待のリンク → パスワードを設定 → 利用開始待ち(登録しただけでは使えない)
    const invCtx = await browser.newContext(PC);
    const invPage = track(await invCtx.newPage());
    await invPage.goto(await linkFor("invite", invitee));
    await waitText(invPage, "下のボタンを押すと、招待を受けて、パスワードの設定に進みます");
    await invPage.getByRole("button", { name: "招待を受けて続ける" }).click();
    await invPage.waitForURL(/\/auth\/verify/, { timeout: 60_000 });
    await waitText(invPage, "パスワードを設定してください");
    const invPassword = password();
    await invPage.locator("#verify-password").fill(invPassword);
    await invPage.locator("#verify-passwordConfirm").fill(invPassword);
    await invPage.getByRole("button", { name: "パスワードを設定して続ける" }).click();
    await invPage.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
    const invStatus = await body(invPage);
    check(
      "招待: パスワードを設定すると、登録済みの店舗の利用開始待ちへ進む(プランは出さない・承認を約束しない)",
      (await invPage.locator("#profile-name").inputValue()) === "運営が追加するサロン" &&
        invStatus.includes("店舗情報の登録が完了しました") &&
        !/口コミプラン|契約プラン|案内予定のプラン/.test(invStatus) &&
        !PROMISES.test(invStatus),
    );
    await invPage.goto(`${BASE}/dashboard`);
    await invPage.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
    check("招待の手続きが済んでも、登録しただけでは使えない", !(await allowed(salonId, "reviews")));

    // 運営: テスト用に指定する(運営の動作確認用。契約プランは、このときの案内予定のプラン)
    await opPage.reload();
    await waitText(opPage, "招待手続き完了(本人がパスワードを設定)");
    const changeRadio = (label: string) => opPage.locator("#service").locator("label", { hasText: label }).locator("input[type=radio]");
    await changeRadio("テスト用に変更").check();
    await opPage.getByRole("button", { name: "変更内容を確認" }).first().click();
    const testDialog = await opPage.getByRole("dialog").innerText();
    check(
      "テスト用の確認: このときから契約プランとして使うプランと、テスト用でも実際の送信がありうることを出す",
      testDialog.includes("【契約プラン】SalonPackを、このときから契約プランとして使います") &&
        testDialog.includes("テスト用でも、操作によっては実際のメール・LINE の送信が発生することがあります") &&
        testDialog.includes("自動では開始・再開しません"),
    );
    await opPage.getByRole("button", { name: "この内容で保存" }).click();
    await waitText(opPage, "利用区分を保存しました");
    await waitText(opPage, "利用開始: 契約プランはSalonPack(テスト用)");
    check("テスト用: 保存すると test。契約プランの開始を履歴に残す", (await salonRow(salonId)).service_status === "test");
    await invPage.goto(`${BASE}/dashboard`);
    await invPage.waitForURL(/\/dashboard/, { timeout: 60_000 });
    await invPage.waitForLoadState("networkidle");
    check("テスト店舗は、決済なしで許可した機能を使える", !invPage.url().includes("/onboarding") && (await allowed(salonId, "reviews")));
    const { data: rops } = await admin.from("reservation_notification_operations").select("state").eq("salon_id", salonId).maybeSingle();
    check("テスト用にしても、予約通知は始まらない", !rops || (rops as { state: string }).state !== "active");
    // テスト用を止めると、利用開始待ちに戻る(新しい店舗なので無料提供には戻せない)
    await changeRadio("利用開始待ちに変更").check();
    await opPage.getByRole("button", { name: "変更内容を確認" }).first().click();
    const backDialog = await opPage.getByRole("dialog").innerText();
    check("止める確認: 機能が止まることをぼかさない", backDialog.includes("【利用開始待ちにすると】この店舗では、サービスの機能が使えなくなります"));
    await opPage.getByRole("button", { name: "この内容で保存" }).click();
    await waitStatus(salonId, "pending");
    await invPage.goto(`${BASE}/dashboard`);
    await invPage.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
    await opPage.reload();
    check(
      "止めた新しい店舗: 選べるのはテスト用だけ(無料提供は出さない)。契約と利用許可は読み取りだけ",
      (await opPage.locator("#service").locator("label", { hasText: "無料提供" }).count()) === 0 &&
        (await body(opPage)).includes("利用開始待ちのため、契約プランはまだありません"),
    );
    await invCtx.close();

    // お客様が自分で登録した店舗(プラン未定): テスト用は理由を出して押せない。プランは「未定」
    await opPage.goto(`${BASE}/ops/salons/${selfSalonId}`);
    await waitText(opPage, "お客様による登録");
    {
      const detail = await body(opPage);
      const testRadio = changeRadio("テスト用に変更");
      check(
        "プランが未定の店舗: プランは「未定」(契約とは出さない)。テスト用は理由を出して押せない",
        detail.includes("プラン 未定") && detail.includes("選べません: プランが未定のため、テスト用にできません") && (await testRadio.isDisabled()),
      );
      await shot(opPage, "09-ops-detail-placeholder");
    }

    // ---------------------------------------------------------------- 3. 止めている既存の店舗の調整(予約通知は再開しない)
    const existing = await createTestSalon({ plan: "salonpack", serviceStatus: "complimentary", registrationSource: "existing", name: "既存の店舗(確認用)" });
    createdUsers.push(existing.userId);
    // 予約通知が稼働中の状態を作る(擬似の Google・LINE の通知先。送信はしない: テスト用の DB では定期処理は動かない)
    const googleId = randomUUID();
    createdGoogleAccounts.push(googleId);
    await admin.from("google_accounts").insert({
      id: googleId,
      oauth_client_id: "client.test",
      google_sub: `sub${googleId.slice(0, 8)}`,
      email: "inbox@example.invalid",
      refresh_token_ciphertext: "c",
      refresh_token_iv: "i",
      refresh_token_tag: "t",
      key_version: "v1",
      granted_scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    await admin.from("salon_google_bindings").insert({ salon_id: existing.salonId, feature: "gmail", google_account_id: googleId, account_email: "inbox@example.invalid" });
    await admin.from("salon_feature_selections").upsert({ salon_id: existing.salonId, feature_key: "reservation_notifications", selected: true });
    await admin.from("line_connections").insert({ salon_id: existing.salonId, destination_id: `U${existing.salonId.replace(/-/g, "").slice(0, 16)}`, status: "connected", label: "スタッフ" });
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await admin.from("reservation_notification_operations").upsert({
      salon_id: existing.salonId,
      state: "active",
      mail_fetch_since: since,
      mail_fetch_since_reason: "test",
      activated_at: since,
      activated_by: "onboarding-walkthrough",
    });
    const openHolds = async () =>
      ((await admin.from("salon_feature_holds").select("feature_key").eq("salon_id", existing.salonId).is("released_at", null)).data ?? []).map((h) => h.feature_key);
    const pollable = async () => ((await admin.rpc("notifications_list_pollable_salons", { p_allowed_plans: null })).data as Array<{ salon_id: string }>).some((r) => r.salon_id === existing.salonId);
    const opsState = async () => ((await admin.from("reservation_notification_operations").select("state").eq("salon_id", existing.salonId).single()).data as { state: string }).state;
    check("既存の店舗(確認用): 予約通知を送れる店舗に入っている", await pollable());

    await opPage.goto(`${BASE}/ops/salons/${existing.salonId}`);
    await waitText(opPage, "既存の店舗(移行)");
    check("既存の店舗: 無料提供のまま。プランは「契約プラン」", (await body(opPage)).includes("契約プラン SalonPack"));
    await changeRadio("利用開始待ちに変更").check();
    await opPage.getByRole("button", { name: "変更内容を確認" }).first().click();
    await opPage.getByRole("button", { name: "この内容で保存" }).click();
    await waitStatus(existing.salonId, "pending");
    await opPage.reload();
    await waitText(opPage, "この店舗は利用を止めています");
    const stoppedHolds = await openHolds();
    check(
      "既存の店舗を止めた: 予約通知は権限により停止。契約と利用許可は編集できる(保存しても再開しないと出す)",
      stoppedHolds.includes("reservation_notifications") &&
        !(await pollable()) &&
        (await body(opPage)).includes("契約プラン SalonPack(利用停止中)") &&
        (await opPage.locator("#entitlements").locator('input[type=radio][name=plan][value=reviews]').count()) === 1,
    );
    await shot(opPage, "10-ops-existing-stopped");
    const stoppedText = await body(opPage);
    check(
      "止めている既存の店舗の停止の案内: 利用許可の保存ではなく、利用区分の変更を案内する",
      stoppedText.includes("利用区分が「利用開始待ち」のため、解除できません") &&
        stoppedText.includes("再開する場合は、「利用区分」を変更してください") &&
        !stoppedText.includes("先に「契約プラン・使える機能」で利用を許可して保存してください"),
    );
    // 止めている間に、プランと機能の利用許可を変える
    await opPage.locator("#entitlements").locator("input[type=radio][name=plan][value=reviews]").check();
    await opPage.locator("#entitlements").getByRole("button", { name: "変更内容を確認" }).click();
    await opPage.getByRole("dialog").waitFor({ timeout: 60_000 });
    await opPage.getByRole("dialog").getByRole("button", { name: "この内容で保存" }).click();
    await waitText(opPage, "保存しました");
    const afterEdit = await salonRow(existing.salonId);
    check(
      "止めている間に保存しても、利用区分は利用開始待ちのまま・予約通知の停止も続く",
      afterEdit.plan === "reviews" && afterEdit.service_status === "pending" && (await openHolds()).includes("reservation_notifications") && !(await pollable()) && (await opsState()) === "active",
    );
    {
      const ctx = await browser.newContext(PC);
      const page = track(await ctx.newPage());
      await passwordLogin(page, existing.email, existing.password);
      await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      const text = await body(page);
      check("止めている既存の店舗のお客様: 「現在、この店舗ではサービスをご利用いただけません」(新規の案内とは分ける)", text.includes("現在、この店舗ではサービスをご利用いただけません") && !text.includes("店舗情報の登録が完了しました"));
      await ctx.close();
    }
    // 止めたまま、予約通知を含むプランに戻す(利用許可は戻るが、利用区分が止まっているので再開しない)
    await opPage.reload();
    await opPage.locator("#entitlements").locator("input[type=radio][name=plan][value=salonpack]").check();
    await opPage.locator("#entitlements").getByRole("button", { name: "変更内容を確認" }).click();
    await opPage.getByRole("dialog").waitFor({ timeout: 60_000 });
    await opPage.getByRole("dialog").getByRole("button", { name: "この内容で保存" }).click();
    await waitText(opPage, "保存しました");
    const afterSecondEdit = await salonRow(existing.salonId);
    check(
      "止めたまま予約通知を含むプランに戻しても、利用区分は利用開始待ちのまま・予約通知は使えず、停止も続く",
      afterSecondEdit.plan === "salonpack" &&
        afterSecondEdit.service_status === "pending" &&
        !(await allowed(existing.salonId, "reservation_notifications")) &&
        (await openHolds()).includes("reservation_notifications") &&
        !(await pollable()),
    );
    // 無料提供に戻す(既存の店舗だけ)。予約通知の停止は、明示的に解除するまで続く
    await opPage.reload();
    await changeRadio("無料提供に戻す").check();
    await opPage.getByRole("button", { name: "変更内容を確認" }).first().click();
    await opPage.getByRole("button", { name: "この内容で保存" }).click();
    await waitStatus(existing.salonId, "complimentary");
    check(
      "既存の店舗を無料提供に戻すと、契約プランの機能は使える。予約通知の権限による停止は、解除するまで続く(自動で再開しない)",
      (await salonRow(existing.salonId)).service_status === "complimentary" &&
        (await allowed(existing.salonId, "reviews")) &&
        (await allowed(existing.salonId, "reservation_notifications")) &&
        (await openHolds()).includes("reservation_notifications") &&
        !(await pollable()),
    );
    // 再開は、今までどおり運営の明示的な操作(権限による停止の解除)で行う
    await opPage.reload();
    await opPage.getByRole("button", { name: "予約通知の停止を解除する" }).click();
    await opPage.getByRole("button", { name: "解除する", exact: true }).click();
    await opPage.waitForURL(/released=reservation_notifications/, { timeout: 60_000 });
    check(
      "予約通知の再開は、停止の解除(運営の明示的な操作)で行う。解除すると、送れる店舗に戻る",
      (await openHolds()).length === 0 && (await pollable()) && (await opsState()) === "active",
    );

    // ---------------------------------------------------------------- 4. 一覧(仮のプランを契約として出さない)
    await opPage.goto(`${BASE}/ops/salons`);
    const list = await body(opPage);
    check("一覧: 予定のプランは「案内予定」、仮の値は「プラン未定」と出す(契約プランとして出さない)", list.includes("案内予定: SalonPack") && list.includes("プラン未定") && !list.includes("通常登録"));
    await opPage.goto(`${BASE}/ops/salons?plan=salonpack&q=${encodeURIComponent("運営が追加するサロン")}`);
    check("契約プランでの絞り込み: 利用開始待ちの新しい店舗は、契約プランとして絞り込まない", !(await body(opPage)).includes("運営が追加するサロン"));
    await shot(opPage, "11-ops-list");
    {
      const ctx = await browser.newContext(PHONE);
      const page = track(await ctx.newPage());
      await passwordLogin(page, op.email, op.password);
      await page.waitForURL(/\/ops\/salons/, { timeout: 60_000 });
      const listOk = await noHorizontalOverflow(page);
      await page.goto(`${BASE}/ops/salons/new`);
      const newOk = await noHorizontalOverflow(page);
      await page.goto(`${BASE}/ops/salons/${salonId}`);
      await waitText(page, "案内予定のプラン");
      check("スマートフォンの幅: 運営の一覧・追加・詳細の画面が横にはみ出さない", listOk && newOk && (await noHorizontalOverflow(page)));
      await shot(page, "12-ops-detail-phone");
      await ctx.close();
    }
    await opCtx.close();
  }

  // ================================================================== 閉じた状態
  async function closedFlow() {
    // ---------------------------------------------------------------- 1. 新規登録・店舗の登録の受付停止
    {
      const ctx = await browser.newContext(PC);
      const page = track(await ctx.newPage());
      await page.goto(`${BASE}/login`);
      check("受付停止: ログイン画面に新規登録の導線を出さない", (await page.getByRole("link", { name: "新規登録" }).count()) === 0);
      await page.goto(`${BASE}/signup`);
      check("受付停止: 新規登録の画面は受付停止の案内だけ(入力欄が無い)", (await body(page)).includes("現在、こちらからの新規登録は受け付けていません") && (await page.locator("#email").count()) === 0);
      await ctx.close();
    }
    // 店舗を持たないアカウント(Supabase の API で直接作られた場合と同じ)。本人確認は済んでいる
    const loner = email("noshop");
    const lonerPassword = password();
    const { data: lonerUser } = await admin.auth.admin.createUser({ email: loner, password: lonerPassword, email_confirm: true });
    createdUsers.push(lonerUser.user!.id);
    await admin.from("account_verifications").insert({ user_id: lonerUser.user!.id, method: "legacy" });
    {
      const ctx = await browser.newContext(PHONE);
      const page = track(await ctx.newPage());
      await passwordLogin(page, loner, lonerPassword);
      await page.waitForURL(/\/onboarding\/salon/, { timeout: 60_000 });
      const text = await body(page);
      check(
        "受付停止: 店舗を持たないアカウントは、店舗を登録できない(受付停止の案内。入力欄を出さない)",
        text.includes("現在、新規の店舗登録は受け付けていません") && (await page.locator("#profile-name").count()) === 0,
      );
      check("スマートフォンの幅: 受付停止の案内が横にはみ出さない", await noHorizontalOverflow(page));
      await shot(page, "01-shop-registration-closed-phone");
      await ctx.close();
    }
    const client = await browserClient({ email: loner, password: lonerPassword });
    const { data: rpcResult } = await client.rpc("create_own_salon", {
      p_name: "直接の呼び出し",
      p_contact_name: "直接",
      p_business_type: null,
      p_contact_email: null,
      p_contact_phone: null,
      p_slug: `direct-${randomBytes(4).toString("hex")}`,
    });
    const { data: lonerSalons } = await admin.from("profiles").select("id, salons(id)").eq("user_id", lonerUser.user!.id).single();
    check(
      "受付停止: REST から create_own_salon を直接呼んでも、店舗を作らない(closed)",
      (rpcResult as { result: string }).result === "closed" && ((lonerSalons as { salons: unknown[] }).salons ?? []).length === 0,
    );

    // ---------------------------------------------------------------- 2. 受付停止のまま、運営の招待を最後まで
    const op = await createOperatorAccount();
    const opCtx = await browser.newContext(PC);
    const opPage = track(await opCtx.newPage());
    opPage.on("dialog", (d) => void d.accept());
    await passwordLogin(opPage, op.email, op.password);
    await opPage.waitForURL(/\/ops\/salons/, { timeout: 60_000 });
    const invitee = email("closed-invitee");
    const salonId = await registerByOperator(opPage, { name: "受付停止中に招待するサロン", invitee, plan: "reviews" });
    check("受付停止でも、運営はサロンを登録して招待できる", (await salonRow(salonId)).service_status === "pending");
    // 1通目の招待のリンク(このあと再送すると無効になる)
    const firstLink = await linkFor("invite", invitee);
    // 招待の再送(60秒あける。検証モードでは送らず、記録だけ)
    const resend = opPage.getByRole("button", { name: /再送/ });
    for (let i = 0; i < 90 && (await resend.isDisabled()); i++) await opPage.waitForTimeout(1000);
    await resend.click();
    await waitText(opPage, "検証モードのため、実際のメールは送信していません");
    check("招待の再送: 60秒たつと押せ、送信の結果(検証モードでは送っていないこと)を出す", true);
    const latestLink = await linkFor("invite", invitee);
    {
      const ctx = await browser.newContext(PHONE);
      let page = track(await ctx.newPage());
      // 古いリンク(再送の前のメール)を開く → 使えないことと、次にすることを案内する
      await page.goto(firstLink);
      const firstButton = page.getByRole("button", { name: "招待を受けて続ける" });
      await firstButton.waitFor({ timeout: 60_000 });
      await firstButton.click();
      await waitText(page, "このリンクは有効期限が切れているか、すでに使われています");
      const err = await body(page);
      check("古い招待のリンク: 期限切れ・使用済みとして止め、運営に再送を頼むよう案内する", err.includes("運営に招待メールの再送をご依頼ください"));
      await shot(page, "02-invite-link-expired-phone");
      // 新しいリンクからやり直す(メールのリンクと同じく、新しいタブで開く。同じタブで開くとハッシュだけの遷移になり、読み直されない)
      page = track(await ctx.newPage());
      await page.goto(latestLink);
      await waitText(page, "下のボタンを押すと、招待を受けて、パスワードの設定に進みます");
      await page.getByRole("button", { name: "招待を受けて続ける" }).click();
      await page.waitForURL(/\/auth\/verify/, { timeout: 60_000 });
      await waitText(page, "パスワードを設定してください");
      await shot(page, "03-verify-set-phone");
      const pw = password();
      await page.locator("#verify-password").fill(pw);
      await page.locator("#verify-passwordConfirm").fill(pw);
      await page.getByRole("button", { name: "パスワードを設定して続ける" }).click();
      await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      const status = await body(page);
      check(
        "受付停止のまま: 新しいリンクからやり直して、パスワードの設定 → 登録済みの店舗の利用開始待ちまで進める",
        status.includes("店舗情報の登録が完了しました") && !PROMISES.test(status) && (await noHorizontalOverflow(page)),
      );
      await shot(page, "04-status-phone");
      await ctx.close();
      // ログアウトのあと、設定したパスワードでログインできる
      const ctx2 = await browser.newContext(PC);
      const page2 = track(await ctx2.newPage());
      await passwordLogin(page2, invitee, pw);
      await page2.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      check("受付停止のまま: 招待されたお客様は、設定したパスワードでログインできる(利用開始待ちの画面)", true);
      await page2.goto(`${BASE}/dashboard`);
      await page2.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      check("通常の店舗は、招待の手続きが済んでも、登録しただけでは使えない", !(await allowed(salonId, "reviews")));
      await ctx2.close();
    }
    await opPage.reload();
    await waitText(opPage, "招待手続き完了(本人がパスワードを設定)");
    check("運営: 招待手続きが完了したことを出す(利用区分は利用開始待ちのまま)", (await salonRow(salonId)).service_status === "pending");
    await opCtx.close();
  }
}

main().catch((err) => {
  console.error(`止めました: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
