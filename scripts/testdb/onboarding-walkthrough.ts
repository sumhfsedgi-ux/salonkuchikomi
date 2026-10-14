/**
 * 新規登録・運営によるサロン登録と招待・利用区分の、実際のブラウザでの通しの確認(テスト用 DB)。
 * 開発サーバーをテスト用 DB の設定で起動し(SALONPACK_VERIFY_MODE=testdb: 認証のメールは送らない)、
 * 端末にインストール済みの Chrome を playwright-core で操作する。メールのリンクの代わりに、メールを送らない
 * admin.generateLink のトークンで /auth/confirm を開く。アドレスはすべて example.invalid(届かない予約のドメイン)。
 * 既存のパスワード再設定(ブラウザから Supabase に直接頼む送信)は操作しない。
 *
 *   npm i --no-save playwright-core
 *   npx tsx scripts/testdb/onboarding-walkthrough.ts [--channel=chrome|msedge] [--headed]
 * スクリーンショットは ONBOARDING_WALKTHROUGH_SHOTS(省略時は保存しない)。
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { randomBytes } from "node:crypto";
import { buildChildEnv, loadTestTarget } from "./target.mjs";

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const channel = process.argv.find((a) => a.startsWith("--channel="))?.split("=")[1] ?? "chrome";
const headed = process.argv.includes("--headed");
const shotsDir = process.env.ONBOARDING_WALKTHROUGH_SHOTS ?? null;

const target = loadTestTarget({ requireDatabaseUrl: true });
const childEnv = buildChildEnv(target, process.env, PORT) as Record<string, string>;
childEnv.NEXT_PUBLIC_APP_MODE = "salonpack";
childEnv.SELF_SIGNUP_ENABLED = "1";
for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;

interface Locator {
  click(): Promise<void>;
  check(): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  isDisabled(): Promise<boolean>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  first(): Locator;
  locator(selector: string): Locator;
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
    // スクリーンショットのとき、Playwright が入力欄に caret-color を付ける(カーソルを隠す)。ハイドレーションの前だと不一致になる。
    // 画面の不具合ではないため、スクリーンショットを撮るときの、この属性だけの不一致は数えない
    if (shotsDir && /hydrat/i.test(text) && text.includes('caret-color:"transparent"') && !/^[+-]\s{2,}(?!.*caret-color).*$/m.test(text)) return;
    // ハイドレーションの不一致は、どの属性かが末尾に出るため全文を残す
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
  await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage: true });
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

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE_PATH ?? "playwright-core";
  const pw = (await import(spec)) as Playwright & { default?: Playwright };
  const playwright: Playwright = pw.chromium ? pw : pw.default!;
  const { notificationsTestAdminClient } = await import("./notificationsFixtures");
  const admin = notificationsTestAdminClient();
  const createdUsers: string[] = [];
  let operatorId: string | null = null;
  const server = startServer();
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

  try {
    await waitForServer();
    await warmUp();
    console.log(`開発サーバー・ブラウザ(${channel}${headed ? "" : "・画面なし"})・テスト用DB・認証メールは送らない(検証モード)`);

    // ------------------------------------------------------------------ 1. お客様自身の新規登録
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
      await waitText(page, "ご入力のメールアドレスでお手続きできる場合は");
      const sent = await body(page);
      check("新規登録: 登録済みかどうかを出さない共通の文と、検証モードの表示", sent.includes("すでに登録済みの場合はメールは届きません") && sent.includes("検証モードのため"));
      await shot(page, "01-signup-sent");
      const userId = await userIdOf(ownerEmail);
      createdUsers.push(userId);

      // 確認の前にログインすると、確認が済んでいないことを案内する(パスワードが正しいときだけ)
      await passwordLogin(page, ownerEmail, ownerPassword);
      await waitText(page, "メールアドレスの確認が済んでいません");
      check("確認の前のログイン: 確認のメールの再送を出す", (await page.getByRole("button", { name: "確認のメールを再送する" }).count()) === 1);

      // 確認のリンク(メールの代わり)→ ボタンを押してから検証 → 本人確認(登録したパスワードを入れ直す)
      await page.goto(await linkFor("magiclink", ownerEmail));
      await waitText(page, "メールのリンクを確認しました");
      check("確認のリンク: 開いただけでは検証せず、ボタンを押して続ける", page.url().endsWith("/auth/confirm"));
      await page.getByRole("button", { name: /ログインして続ける/ }).click();
      await page.waitForURL(/\/auth\/verify/, { timeout: 60_000 });
      await waitText(page, "登録したパスワード");
      await shot(page, "02-verify-confirm");
      await page.locator("#verify-password").fill("wrong-password-1");
      await page.getByRole("button", { name: "確認して続ける" }).click();
      await waitText(page, "パスワードが一致しません");
      await page.locator("#verify-password").fill(ownerPassword);
      await page.getByRole("button", { name: "確認して続ける" }).click();
      await page.waitForURL(/\/onboarding\/salon/, { timeout: 60_000 });
      check("本人確認のあと、店舗の情報の入力へ進む", true);
      await ctx.close();
    }
    // 途中で離れたあと、もう一度ログインすると、店舗の情報の入力から再開する
    {
      const ctx = await browser.newContext(PC);
      const page = track(await ctx.newPage());
      await passwordLogin(page, ownerEmail, ownerPassword);
      await page.waitForURL(/\/onboarding\/salon/, { timeout: 60_000 });
      check("再ログイン: 未完了の手続き(店舗の情報)から再開する", true);
      const form = await body(page);
      check("店舗の情報: 必須・任意を表示し、連絡用メールは「ログイン用と同じ」が初期値", form.includes("必須") && form.includes("任意") && form.includes(`ログイン用と同じ(${ownerEmail})`));
      await page.getByRole("button", { name: "店舗を登録する" }).click();
      await waitText(page, "サロン名を入力してください");
      check("店舗の情報: 未入力は欄の近くに出す", (await page.locator("#profile-name").getAttribute("aria-invalid")) === "true");
      await page.locator("#profile-name").fill("ウォークスルーのサロン");
      await page.locator("#profile-contactName").fill("確認 太郎");
      await page.locator("#profile-contactPhone").fill("０３－１２３４－５６７８");
      await page.getByRole("button", { name: "店舗を登録する" }).click();
      await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      const status = await body(page);
      check(
        "店舗の登録: 「お申し込みを受け付けました。利用開始のご案内をお待ちください。」と、契約・支払いが無いことを出す",
        status.includes("お申し込みを受け付けました。利用開始のご案内をお待ちください。") && status.includes("お支払いの手続きは、まだ発生していません"),
      );
      await shot(page, "03-status-pending");
      const { data: salon } = await admin
        .from("salons")
        .select("id, slug, plan, service_status, registration_source, contact_phone")
        .eq("name", "ウォークスルーのサロン")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      check(
        "店舗は利用開始待ち・口コミプラン・お客様による登録。電話番号は半角にそろう",
        salon?.service_status === "pending" && salon?.plan === "reviews" && salon?.registration_source === "self_signup" && salon?.contact_phone === "03-1234-5678",
      );
      // 利用開始待ちでの直接アクセス
      for (const path of ["/dashboard", "/dashboard/reviews", "/dashboard/settings", "/dashboard/setup/reviews"]) {
        await page.goto(`${BASE}${path}`);
        await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      }
      check("利用開始待ち: ダッシュボードの各画面に直接アクセスしても、利用開始待ちの画面に戻る", true);
      const pub = await fetch(`${BASE}/review/${salon!.slug}`).then((r) => r.text());
      check("利用開始待ち: お客様用ページは「現在ご利用いただけません」", pub.includes("現在ご利用いただけません"));
      const gen = await fetch(`${BASE}/api/generate-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salonId: salon!.id, answers: [] }),
      });
      check("利用開始待ち: 生成 API は 403(理由は返さない)", gen.status === 403);
      // 登録内容の修正(利用開始待ちでもできる)
      await page.goto(`${BASE}/onboarding/status`);
      await page.locator("#profile-contactName").fill("確認 花子");
      await waitText(page, "保存していない変更があります");
      await page.getByRole("button", { name: "登録内容を保存する" }).click();
      await waitText(page, "登録内容を保存しました");
      check("利用開始待ち: 登録内容を確認・修正できる(未保存・保存の状態を出す)", true);
      await ctx.close();
    }
    // スマートフォンの幅
    {
      const ctx = await browser.newContext(PHONE);
      const page = track(await ctx.newPage());
      await page.goto(`${BASE}/signup`);
      const signupOk = await noHorizontalOverflow(page);
      await passwordLogin(page, ownerEmail, ownerPassword);
      await page.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
      check("スマートフォンの幅: 新規登録・利用開始待ちの画面が横にはみ出さない", signupOk && (await noHorizontalOverflow(page)));
      await shot(page, "04-status-phone");
      await ctx.close();
    }

    // ------------------------------------------------------------------ 2. 運営によるサロンの追加と招待
    const opEmail = email("ops");
    const opPassword = password();
    const { data: op } = await admin.auth.admin.createUser({ email: opEmail, password: opPassword, email_confirm: true });
    createdUsers.push(op.user!.id);
    operatorId = op.user!.id;
    await admin.from("account_verifications").insert({ user_id: op.user!.id, method: "legacy" });
    await admin.from("operator_admins").insert({ user_id: op.user!.id, granted_by: "onboarding-walkthrough", note: "test" });

    const invitee = email("invitee");
    const opCtx = await browser.newContext(PC);
    const opPage = track(await opCtx.newPage());
    opPage.on("dialog", (d) => void d.accept());
    await passwordLogin(opPage, opEmail, opPassword);
    await opPage.waitForURL(/\/ops\/salons/, { timeout: 60_000 });
    await opPage.getByRole("link", { name: "サロンを追加" }).click();
    await opPage.waitForURL(/\/ops\/salons\/new/);
    await opPage.locator("#draft-name").fill("運営が追加するサロン");
    await opPage.getByRole("button", { name: "下書きを保存" }).click();
    await opPage.waitForURL(/\/ops\/salons\/drafts\//, { timeout: 60_000 });
    await waitText(opPage, "下書きを保存しました");
    check("サロンを追加: サロン名だけで下書きを保存できる(アカウント・店舗・メールは作らない)", (await userIdOf(invitee).catch(() => null)) === null);
    // 機能のスイッチ: プランを選ぶまで押せない。口コミプランではブログは「プラン対象外」で押せない
    await opPage.locator("#draft-plan").selectOption("reviews");
    const blogSwitch = opPage.getByRole("switch", { name: "ブログの利用を許可する" });
    check("口コミプランのブログは「プラン対象外」と表示し、スイッチを押せない", (await blogSwitch.isDisabled()) && (await body(opPage)).includes("プラン対象外"));
    await opPage.locator("#draft-plan").selectOption("salonpack");
    await opPage.getByRole("switch", { name: "ブログの利用を許可する" }).click();
    await opPage.locator("#draft-contactName").fill("担当 次郎");
    await opPage.locator("#draft-loginEmail").fill(invitee);
    await opPage.locator("label", { hasText: "利用開始待ち" }).locator("input[type=radio]").check();
    await opPage.getByRole("button", { name: /内容を確認/ }).click();
    await opPage.getByRole("dialog").waitFor({ timeout: 60_000 });
    const confirmText = await opPage.getByRole("dialog").innerText();
    check(
      "確認画面: 店舗・招待先・プラン・利用区分・機能・新しいアカウント・利用開始待ちを出す",
      confirmText.includes("運営が追加するサロン") &&
        confirmText.includes(invitee) &&
        confirmText.includes("SalonPack") &&
        confirmText.includes("新しいアカウントを作り") &&
        confirmText.includes("登録のあとも「利用開始待ち」です"),
    );
    await shot(opPage, "05-ops-confirm");
    await opPage.getByRole("button", { name: "登録して招待メールを送信" }).click();
    await opPage.waitForURL(/\/ops\/salons\/[0-9a-f-]{36}\?registered=/, { timeout: 60_000 });
    await waitText(opPage, "検証モードのため、案内のメールは送信していません");
    const detail = await body(opPage);
    check("本登録のあと: 招待の状態(未完了)と利用区分を分けて出す", detail.includes("招待未完了(メールアドレスの確認がまだ)") && detail.includes("利用開始待ち"));
    check(
      "利用開始待ちの店舗の「契約プラン・使える機能」: 何も変えていなければ「まだ反映されていません」を出さない",
      !detail.includes("この変更はまだ反映されていません") && detail.includes("利用開始(利用区分の変更)のあとに使えるようになります"),
    );
    await shot(opPage, "06-ops-detail");
    const resend = opPage.getByRole("button", { name: /再送/ });
    check("再送: 60秒たつまで押せない", await resend.isDisabled());
    const salonId = opPage.url().match(/salons\/([0-9a-f-]{36})/)![1];
    const inviteeId = await userIdOf(invitee);
    createdUsers.push(inviteeId);

    // 招待された本人: 招待のリンク → パスワードを設定 → 利用開始待ち
    const invCtx = await browser.newContext(PC);
    const invPage = track(await invCtx.newPage());
    await invPage.goto(await linkFor("invite", invitee));
    await invPage.getByRole("button", { name: "招待を受けて続ける" }).click();
    await invPage.waitForURL(/\/auth\/verify/, { timeout: 60_000 });
    await waitText(invPage, "新しいパスワード");
    const invPassword = password();
    await invPage.locator("#verify-password").fill(invPassword);
    await invPage.locator("#verify-passwordConfirm").fill(invPassword);
    await invPage.getByRole("button", { name: "パスワードを設定して続ける" }).click();
    await invPage.waitForURL(/\/onboarding\/status/, { timeout: 60_000 });
    check("招待: パスワードを設定すると、登録済みの店舗(利用開始待ち)へ進む(店舗を作り直させない)", (await invPage.locator("#profile-name").inputValue()) === "運営が追加するサロン");

    // 運営: 利用区分を無償提供にする(利用開始)
    await opPage.reload();
    await waitText(opPage, "招待手続き完了(本人がパスワードを設定)");
    check("運営: 本人がパスワードを設定すると「招待手続き完了」と、その根拠を出す", (await body(opPage)).includes("判断の根拠"));
    await opPage.locator("label", { hasText: "無償提供" }).locator("input[type=radio]").first().check();
    await opPage.getByRole("button", { name: "変更内容を確認" }).first().click();
    const statusDialog = await opPage.getByRole("dialog").innerText();
    check(
      "利用区分の確認: 使える機能・停止を解除しないこと・予約通知を自動で始めないことを出す",
      statusDialog.includes("変更のあとに使える機能") && statusDialog.includes("自動で開始・再開しません"),
    );
    await opPage.getByRole("button", { name: "この内容で保存" }).click();
    await waitText(opPage, "利用区分を保存しました");
    await invPage.goto(`${BASE}/dashboard`);
    await invPage.waitForURL(/\/dashboard/, { timeout: 60_000 });
    await invPage.waitForLoadState("networkidle");
    check("利用開始のあと: 同じ店舗のままダッシュボードを使える", !invPage.url().includes("/onboarding"));
    const { data: ops } = await admin.from("reservation_notification_operations").select("state").eq("salon_id", salonId).maybeSingle();
    check("利用開始しても、予約通知は始まらない", !ops || (ops as { state: string }).state !== "active");
    await invCtx.close();

    // 本人確認済みの既存のアカウント(店舗なし)に登録: パスワードを変えず、店舗登録のお知らせを送る
    const existing = email("existing");
    const existingPw = password();
    const { data: ex } = await admin.auth.admin.createUser({ email: existing, password: existingPw, email_confirm: true });
    createdUsers.push(ex.user!.id);
    await admin.from("account_verifications").insert({ user_id: ex.user!.id, method: "legacy" });
    await opPage.goto(`${BASE}/ops/salons/new`);
    await opPage.locator("#draft-name").fill("既存のアカウントのサロン");
    await opPage.locator("#draft-contactName").fill("既存 三郎");
    await opPage.locator("#draft-loginEmail").fill(existing);
    await opPage.locator("#draft-plan").selectOption("reviews");
    await opPage.locator("label", { hasText: "テスト店舗" }).locator("input[type=radio]").check();
    await opPage.getByRole("button", { name: /内容を確認/ }).click();
    const exConfirm = await opPage.getByRole("dialog").innerText();
    check(
      "既存のアカウント: 紐付け先を明示し、パスワードは変えず、店舗登録のお知らせを送る",
      exConfirm.includes("登録済みのアカウント(本人確認済み)") && exConfirm.includes("パスワードは変えません") && exConfirm.includes("店舗登録のお知らせ"),
    );
    await opPage.getByRole("button", { name: "登録して招待メールを送信" }).click();
    await opPage.waitForURL(/\/ops\/salons\/[0-9a-f-]{36}\?registered=/, { timeout: 60_000 });
    const exLogin = await (async () => {
      const ctx = await browser.newContext(PC);
      const page = track(await ctx.newPage());
      await passwordLogin(page, existing, existingPw);
      await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
      const ok = !page.url().includes("/onboarding") && !page.url().includes("/auth/verify");
      await ctx.close();
      return ok;
    })();
    check("既存のアカウント: 今のパスワードでログインでき、テスト店舗としてすぐ使える", exLogin);

    // 店舗を持つアカウントには紐付けない(既存の店舗へのリンクを出す)
    await opPage.goto(`${BASE}/ops/salons/new`);
    await opPage.locator("#draft-name").fill("重複のサロン");
    await opPage.locator("#draft-contactName").fill("重複");
    await opPage.locator("#draft-loginEmail").fill(ownerEmail);
    await opPage.locator("#draft-plan").selectOption("reviews");
    await opPage.locator("label", { hasText: "無償提供" }).locator("input[type=radio]").check();
    await opPage.getByRole("button", { name: /内容を確認/ }).click();
    const dupConfirm = await opPage.getByRole("dialog").innerText();
    check(
      "既にサロンを持つアカウント: 重複して作らず、既存の店舗への導線を出し、登録を押せない",
      dupConfirm.includes("すでに店舗を持っています") && (await opPage.getByRole("button", { name: "登録して招待メールを送信" }).isDisabled()),
    );
    await shot(opPage, "07-ops-duplicate");
    await opPage.getByRole("button", { name: "戻る" }).click();

    // 一覧: 下書き・利用区分・招待の状態
    await opPage.goto(`${BASE}/ops/salons`);
    const list = await body(opPage);
    check("一覧: 下書きを見分けられ、利用区分(テスト店舗など)を文字で出す", list.includes("下書き") && list.includes("テスト店舗") && list.includes("利用開始待ち"));
    {
      const ctx = await browser.newContext(PHONE);
      const page = track(await ctx.newPage());
      await passwordLogin(page, opEmail, opPassword);
      await page.waitForURL(/\/ops\/salons/, { timeout: 60_000 });
      await page.goto(`${BASE}/ops/salons/new`);
      check("スマートフォンの幅: 運営の一覧・追加の画面が横にはみ出さない", await noHorizontalOverflow(page));
      await ctx.close();
    }
    await opCtx.close();
  } finally {
    if (operatorId) await admin.from("salon_drafts").delete().eq("created_by", operatorId);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    await browser.close().catch(() => undefined);
    // Windows では先にシェルを止めると next dev が残るため、プロセスの木ごと止める
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill();
  }
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
