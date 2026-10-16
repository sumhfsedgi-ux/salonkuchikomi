/**
 * 届いた口コミ(第1段階)のブラウザでの通しの確認(テスト用DB + 架空の Google + 架空の返信案)。
 * 確かめる項目は docs/plans/reviews-inbox-browser-check.md。開発サーバーをテスト用DBの設定で起動し、インストール済みの
 * Chrome を playwright-core で操作する。実在の Google・OpenAI・LINE には接続しない(OpenAI の値は空で起動する)。
 *
 *   npx tsx scripts/testdb/reviews-browser-check.ts setup      届いた口コミを「提供中」にする(変える前の値を状態のファイルに残す)
 *   npx tsx scripts/testdb/reviews-browser-check.ts run        確認用の店舗を作って確かめ、終わったら店舗・架空の Google のアカウントを消す
 *   npx tsx scripts/testdb/reviews-browser-check.ts teardown   提供状態を元に戻し、残った確認用のデータを消す
 *
 * 環境変数:PLAYWRIGHT_CORE_PATH(playwright-core の場所)・REVIEWS_CHECK_DIR(状態のファイル・画面の画像の置き場所)。
 * 共有・本番の DB には接続しない(scripts/testdb/target.mjs で確かめる)。
 */
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { buildChildEnv, loadTestTarget } from "./target.mjs";

const mode = process.argv[2] ?? "run";
const PORT = Number(process.env.REVIEWS_CHECK_PORT ?? 3211);
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.REVIEWS_CHECK_DIR ?? path.resolve("reviews-check-out");
const SHOTS = path.join(OUT, "screenshots");
const STATE_FILE = path.join(OUT, "reviews-check-state.json");
const EMAIL_PREFIX = "reviews-check-";
const SIM_SUBS = ["100000000000000000001", "100000000000000000002"];
const SIM_CLIENT = "salonpack-testdb.apps.invalid";

const target = loadTestTarget({ requireDatabaseUrl: true });
const childEnv = buildChildEnv(target, process.env, PORT) as Record<string, string>;
childEnv.GOOGLE_REVIEWS_OAUTH_ENABLED = "1";
childEnv.NEXT_PUBLIC_APP_MODE = "salonpack";
childEnv.OPENAI_API_KEY = "";
childEnv.OPENAI_MODEL = "";
for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;

// ---- playwright-core の使う部分だけの型 ----
interface Locator {
  click(): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
  check(): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  inputValue(): Promise<string>;
  innerText(): Promise<string>;
  isVisible(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  first(): Locator;
  last(): Locator;
  nth(i: number): Locator;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp): Locator;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}
interface Response {
  status(): number;
}
interface Page {
  goto(url: string): Promise<Response | null>;
  url(): string;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp): Locator;
  getByLabel(text: string | RegExp): Locator;
  waitForURL(url: string | RegExp | ((url: URL) => boolean), options?: { timeout?: number }): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  reload(): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  close(): Promise<void>;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  on(event: "request", handler: (request: { url(): string }) => void): void;
}
interface ContextOptions {
  viewport?: { width: number; height: number };
  userAgent?: string;
  isMobile?: boolean;
  hasTouch?: boolean;
  deviceScaleFactor?: number;
}
interface Browser {
  newContext(options?: ContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { channel: string; headless: boolean }): Promise<Browser> };
}

const PC: ContextOptions = { viewport: { width: 1280, height: 800 } };
const PHONE: ContextOptions = {
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

type AdminClient = ReturnType<Awaited<typeof import("./notificationsFixtures")>["notificationsTestAdminClient"]>;

const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
function check(label: string, ok: boolean, detail = "") {
  results.push({ ok, label, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail && !ok ? ` — ${detail}` : ""}`);
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function bodyText(page: Page): Promise<string> {
  return page.locator("body").innerText().catch(() => "");
}

async function waitText(page: Page, value: string | RegExp, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const body = await bodyText(page);
    if (typeof value === "string" ? body.includes(value) : value.test(body)) return;
    if (Date.now() > deadline) throw new Error(`「${value}」が表示されません(${page.url()}): ${body.slice(0, 600).replace(/\s+/g, " ")}`);
    await page.waitForTimeout(300);
  }
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/(dashboard|onboarding|ops)/, { timeout: 90_000 });
  await page.waitForLoadState("networkidle");
}

/** 架空の Google の操作の口(app/api/dev/simulated-gbp)。 */
async function ctl(page: Page, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return page.evaluate(async (b) => {
    const res = await fetch("/api/dev/simulated-gbp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return (await res.json()) as Record<string, unknown>;
  }, body);
}

async function simState(page: Page, reviewName?: string): Promise<{ calls: string[]; reply?: { comment?: string } | null }> {
  return page.evaluate(async (name) => {
    const res = await fetch(`/api/dev/simulated-gbp${name ? `?reviewName=${encodeURIComponent(name)}` : ""}`);
    return (await res.json()) as { calls: string[]; reply?: { comment?: string } | null };
  }, reviewName ?? "");
}

/**
 * 架空の Google の同意画面で、アカウントを選んで「許可する」を押し、SalonPack に戻るまで待つ。
 * 再接続で Google が新しい認証情報を返さないときは、アプリが同意の画面(prompt=consent)でもう一度求めるので、それも許可する。
 */
async function approveOnSimulatedGoogle(page: Page, accountEmail: string, back: RegExp): Promise<string> {
  await page.waitForURL(/oauth\/simulated-authorize/, { timeout: 90_000 });
  const consent = await bodyText(page);
  for (let round = 0; round < 2; round++) {
    await page.locator("label", { hasText: accountEmail }).locator("input[type=radio]").check();
    await page.getByRole("button", { name: "許可する" }).click();
    await page.waitForURL((url: URL) => back.test(url.toString()) || (/oauth\/simulated-authorize/.test(url.toString()) && round === 0), { timeout: 90_000 });
    await page.waitForLoadState("networkidle");
    if (back.test(page.url())) return consent;
  }
  throw new Error(`架空の Google から戻りません(${page.url()})`);
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1, null);
}

/** ページの高さが、画面の中身(main の下端)より長くなっていないか。見えない要素のはみ出しで下に空白ができていないか。 */
async function noExtraPageHeight(page: Page): Promise<{ ok: boolean; detail: string }> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const contentBottom = main ? Math.ceil(main.getBoundingClientRect().bottom + window.scrollY) : 0;
    const pageHeight = document.documentElement.scrollHeight;
    return { ok: main !== null && pageHeight <= contentBottom + 1, detail: `ページ ${pageHeight}px・中身 ${contentBottom}px` };
  }, null);
}

async function openReview(page: Page, text: string) {
  await page.locator("a", { hasText: text }).first().click();
  await page.getByRole("button", { name: /^返信案を作成$|^作り直す$|返信を編集|反映状況を再確認/ }).first().waitFor({ timeout: 60_000 });
}

/** 詳細(article)の中で、その文言が何回出るか(同じ説明を繰り返していないかの確認)。 */
async function countInDetail(page: Page, value: string): Promise<number> {
  const text = await page.locator("article").first().innerText().catch(() => "");
  return text.split(value).length - 1;
}

const composerText = (page: Page) => page.locator("textarea").first();

/** 口コミの画面のタブ(口コミ | アンケート | 設定)。タブが無ければ空。 */
const TAB_NAV = 'nav[aria-label="口コミ機能内のナビゲーション"]';
async function tabLabels(page: Page): Promise<string[]> {
  const nav = page.locator(TAB_NAV);
  if ((await nav.count()) === 0) return [];
  return (await nav.first().innerText()).split(/\s+/).filter(Boolean);
}
async function activeTab(page: Page): Promise<string> {
  return (await page.locator(`${TAB_NAV} a[aria-current="page"]`).first().innerText()).trim();
}
/** メニューの「口コミ」(PC は左のメニュー、スマートフォンは下のメニュー)。 */
function menuReviews(page: Page, where: "side" | "bottom"): Locator {
  return page.locator(where === "side" ? "aside nav a" : 'nav[aria-label="メインナビゲーション"] a', { hasText: "口コミ" }).first();
}

async function pickLocation(page: Page, locationName: string) {
  await page.locator(`input[type=radio][value="${locationName}"]`).check();
  await page.getByRole("button", { name: "この店舗と連携する" }).click();
  await page.getByText("口コミ数").first().waitFor({ timeout: 120_000 });
  await page.waitForLoadState("networkidle");
}

async function changeLocation(page: Page) {
  await page.goto(`${BASE}/dashboard/reviews/settings`);
  await page.getByText("連携する店舗を変更する").click();
  await page.getByText("一時保存した口コミと下書きが削除されることを確認しました").click();
  await page.getByRole("button", { name: "店舗を選び直す" }).click();
  await page.waitForURL(/\/dashboard\/reviews\/google/, { timeout: 60_000 });
  await page.getByRole("button", { name: "この店舗と連携する" }).waitFor({ timeout: 60_000 });
}

async function sendFromDialog(page: Page, button: string) {
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor({ timeout: 30_000 });
  await dialog.getByRole("button", { name: button, exact: true }).click();
}

function startServer(): ChildProcess {
  return spawn("npx", ["next", "dev", "-p", String(PORT)], { env: childEnv as NodeJS.ProcessEnv, shell: true, stdio: "ignore" });
}

/** ほかのサーバー(古い開発サーバーなど)がそのポートで動いていたら、取り違えないように止める。 */
async function assertPortFree() {
  const answered = await fetch(`${BASE}/login`, { redirect: "manual" }).then(() => true, () => false);
  if (answered) throw new Error(`ポート ${PORT} で、すでにほかのサーバーが動いています(REVIEWS_CHECK_PORT で別のポートを指定してください)`);
}

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("開発サーバーが起動しませんでした");
}

async function warmUp() {
  for (const p of [
    "/login",
    "/dashboard",
    "/dashboard/reviews",
    "/dashboard/reviews/google",
    "/dashboard/reviews/settings",
    "/dashboard/settings/google",
    "/api/google/oauth/simulated-authorize",
    "/api/dev/simulated-gbp",
  ]) {
    await fetch(`${BASE}${p}`, { redirect: "manual" }).catch(() => {});
  }
}

interface Shop {
  userId: string;
  salonId: string;
  email: string;
  password: string;
}

async function createShop(admin: AdminClient, opts: { key: string; name: string; plan: "reviews" | "salonpack"; allow: boolean }): Promise<Shop> {
  const email = `${EMAIL_PREFIX}${opts.key}-${Date.now()}@example.invalid`;
  const password = `Rc${Math.random().toString(36).slice(2, 12)}!7`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`確認用のユーザーを作れません: ${error?.message}`);
  const userId = data.user.id;
  const { data: profile } = await admin.from("profiles").select("id").eq("user_id", userId).single();
  const slug = `${EMAIL_PREFIX}${opts.key}-${Date.now()}`;
  const { data: salon, error: salonError } = await admin
    .from("salons")
    .insert({ owner_id: profile!.id, name: opts.name, slug, plan: opts.plan, service_status: "complimentary", registration_source: "existing" })
    .select("id")
    .single();
  if (salonError || !salon) throw new Error(`確認用の店舗を作れません: ${salonError?.message}`);
  await admin.from("account_verifications").insert({ user_id: userId, method: "legacy" });
  if (opts.allow) {
    const { error: e } = await admin.from("salon_feature_overrides").insert({ salon_id: salon.id, feature_key: "google_reviews", mode: "allow" });
    if (e) throw new Error(`利用の許可を入れられません: ${e.message}`);
  }
  return { userId, salonId: salon.id as string, email, password };
}

/**
 * 確認用のユーザー(店舗ごと消える)と、架空の Google の利用者のアカウント(結び付けが無いもの)を消す。
 * 削除の失敗は、黙って続けずに知らせる(0031 の前は、口コミを連携した店舗の削除がトリガーで失敗していた)。
 */
async function cleanupData(admin: AdminClient): Promise<{ users: number; accounts: number; errors: string[] }> {
  let users = 0;
  const errors: string[] = [];
  const targets: string[] = [];
  for (let page = 1; page < 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const list = data?.users ?? [];
    for (const u of list) if (u.email?.startsWith(EMAIL_PREFIX)) targets.push(u.id);
    if (list.length < 200) break;
  }
  for (const id of targets) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) errors.push(`user ${id}: ${error.message}`);
    else users++;
  }
  const { data: accounts } = await admin.from("google_accounts").select("id").eq("oauth_client_id", SIM_CLIENT).in("google_sub", SIM_SUBS);
  let removed = 0;
  for (const a of accounts ?? []) {
    const { count } = await admin.from("salon_google_bindings").select("salon_id", { count: "exact", head: true }).eq("google_account_id", a.id);
    if ((count ?? 0) === 0) {
      await admin.from("google_accounts").delete().eq("id", a.id);
      removed++;
    }
  }
  return { users, accounts: removed, errors };
}

async function setLifecycle(admin: AdminClient, lifecycle: string) {
  const { error } = await admin.from("feature_catalog").update({ lifecycle }).eq("feature_key", "google_reviews");
  if (error) throw new Error(`提供状態を変えられません: ${error.message}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { notificationsTestAdminClient } = await import("./notificationsFixtures");
  const admin = notificationsTestAdminClient();

  if (mode === "setup") {
    const { data } = await admin.from("feature_catalog").select("lifecycle").eq("feature_key", "google_reviews").single();
    const { data: accounts } = await admin.from("google_accounts").select("id").eq("oauth_client_id", SIM_CLIENT).in("google_sub", SIM_SUBS);
    if ((accounts ?? []).length > 0) throw new Error("架空の Google の利用者のアカウントがすでにあります(確認の前の状態と区別できないため止めます)");
    if (!existsSync(STATE_FILE)) writeFileSync(STATE_FILE, JSON.stringify({ googleReviewsLifecycleBefore: data!.lifecycle, at: new Date().toISOString() }, null, 2));
    await setLifecycle(admin, "available");
    console.log(`setup: google_reviews の提供状態 ${data!.lifecycle} → available(前の値は ${STATE_FILE})`);
    return;
  }
  if (mode === "cleanup") {
    const removed = await cleanupData(admin);
    console.log(`cleanup: 確認用のユーザー ${removed.users}・架空の Google のアカウント ${removed.accounts}${removed.errors.length ? `・失敗 ${removed.errors.join(" / ")}` : ""}`);
    if (removed.errors.length) process.exitCode = 1;
    return;
  }
  if (mode === "teardown") {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { googleReviewsLifecycleBefore: string };
    const removed = await cleanupData(admin);
    if (removed.errors.length) throw new Error(`片付けに失敗: ${removed.errors.join(" / ")}`);
    await setLifecycle(admin, state.googleReviewsLifecycleBefore);
    console.log(`teardown: 確認用のユーザー ${removed.users}・架空の Google のアカウント ${removed.accounts} を消し、提供状態を ${state.googleReviewsLifecycleBefore} に戻しました`);
    return;
  }

  const modulePath = process.env.PLAYWRIGHT_CORE_PATH;
  const pw = (await import(modulePath ? pathToFileURL(modulePath).href : "playwright-core")) as Playwright & { default?: Playwright };
  const playwright: Playwright = pw.chromium ? pw : pw.default!;
  const external = new Set<string>();
  const watch = (context: BrowserContext) =>
    context.on("request", (r) => {
      const host = new URL(r.url()).hostname;
      if (host !== "localhost" && host !== "127.0.0.1") external.add(host);
    });

  await assertPortFree();
  const shopA = await createShop(admin, { key: "a", name: "架空サロン 表参道店", plan: "reviews", allow: true });
  const shopB = await createShop(admin, { key: "b", name: "架空サロン 銀座店", plan: "salonpack", allow: true });
  const shopC = await createShop(admin, { key: "c", name: "架空サロン 新宿店", plan: "reviews", allow: false });
  const server = startServer();
  const browser = await playwright.chromium.launch({ channel: "chrome", headless: true });
  let shotIndex = 0;
  const scenario = async (name: string, onPage: () => Page | undefined, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      check(`${name}: 途中で止まりました`, false, String((err as Error)?.message ?? err).slice(0, 600));
      const p = onPage();
      if (p) {
        await shot(p, `fail-${String(++shotIndex).padStart(2, "0")}`).catch(() => undefined);
        // 仕込んだ失敗・遅れが、次の場面に残らないようにする
        await ctl(p, { action: "clear_pending" }).catch(() => undefined);
      }
    }
  };
  try {
    await waitForServer();
    await warmUp();
    console.log("開発サーバー起動・テスト用DB・架空の Google・架空の返信案(OpenAI の値は空)");

    const pc = await browser.newContext(PC);
    watch(pc);
    const page = await pc.newPage();
    await page.goto(`${BASE}/login`);
    await ctl(page, { action: "reset" });

    // ================= A店(口コミプラン・許可あり・アンケートなし) =================
    await scenario("A: 入口・連携・店舗の選択", () => page, async () => {
      await login(page, shopA.email, shopA.password);
      check("A: 口コミプランで許可ありは、ログイン後に「口コミ」タブ(アンケートが無くても初期設定に飛ばない)", /\/dashboard\/reviews\/google$/.test(page.url()), page.url());
      check("A: タブは 口コミ | アンケート | 設定 の順で、「口コミ」が選択中", (await tabLabels(page)).join("|") === "口コミ|アンケート|設定" && (await activeTab(page)) === "口コミ", (await tabLabels(page)).join("|"));
      check("A: 左のメニューの「口コミ」は「口コミ」タブを開く", (await menuReviews(page, "side").getAttribute("href")) === "/dashboard/reviews/google");
      await waitText(page, "口コミ機能を使う前に");
      const intro = await bodyText(page);
      check(
        "A: Google と未接続なら、「口コミ」タブの中で「口コミ機能を使う前に」と、取得・保存/AI/投稿/解除の4つの説明を出す",
        ["取得・保存する情報", "AIに送る情報", "Googleへの投稿", "連携を解除したとき", "最長25日間", "OpenAI", "自動で投稿することはありません"].every((t) => intro.includes(t)),
      );
      check("A: 予約通知の Gmail を連携していない店舗には、Gmail についての説明を出さない", !intro.includes("予約通知のGmail"));
      // 「アンケート」「設定」を選ぶ・URL を直接開くと、それぞれの画面。メニューの「口コミ」は、どのタブでも選択中
      await page.locator(TAB_NAV).getByRole("link", { name: "アンケート" }).click();
      await page.waitForURL(/\/dashboard\/reviews$/, { timeout: 60_000 });
      await waitText(page, "アンケートを作成する");
      check("A: 「アンケート」タブはアンケートの画面(未作成なら作成の案内。初期設定へは移さない)", (await activeTab(page)) === "アンケート");
      check("A: 「アンケート」タブでも、左のメニューの「口コミ」は選択中", (await menuReviews(page, "side").getAttribute("aria-current")) === "page");
      await shot(page, "pc-a-00-survey-tab");
      await page.goto(`${BASE}/dashboard/reviews/settings`);
      await waitText(page, "AI返信");
      check("A: 「設定」タブの URL を直接開くと設定の画面", (await activeTab(page)) === "設定" && (await menuReviews(page, "side").getAttribute("aria-current")) === "page");
      await page.goto(`${BASE}/dashboard/reviews`);
      await waitText(page, "アンケートを作成する");
      check("A: 「アンケート」タブの URL を直接開くとアンケートの画面", /\/dashboard\/reviews$/.test(page.url()) && (await activeTab(page)) === "アンケート");
      await menuReviews(page, "side").click();
      await page.waitForURL(/\/dashboard\/reviews\/google$/, { timeout: 60_000 });
      await waitText(page, "口コミ機能を使う前に");
      check("A: 左のメニューの「口コミ」を押すと「口コミ」タブ", (await activeTab(page)) === "口コミ");
      await shot(page, "pc-a-01-not-connected");
      await page.getByRole("button", { name: "同意してGoogleと接続する" }).click();
      await page.waitForTimeout(800);
      check("A: 同意のチェックが無いと、連携を始めない(画面にとどまる)", /\/dashboard\/reviews\/google/.test(page.url()) && !/simulated-authorize/.test(page.url()));
      await page.getByText("上記の取り扱いに同意します").click();
      await page.getByRole("button", { name: "同意してGoogleと接続する" }).click();
      const consent = await approveOnSimulatedGoogle(page, "owner@example.test", /\/dashboard\/reviews\/google/);
      check("A: 口コミの権限だけを求める(Gmail の権限は求めない)", consent.includes("business.manage") && !consent.includes("gmail"));
      await waitText(page, "連携する店舗を選んでください");
      const picker = await bodyText(page);
      check("A: 店舗の選択の前は「連携が完了」と言わず「Googleアカウントに接続しました」とだけ出す", picker.includes("Googleアカウントに接続しました") && !picker.includes("連携が完了"));
      check("A: どの店舗への紐付けかを示す(SalonPack の店舗名)", picker.includes("SalonPackの「架空サロン 表参道店」と連携するGoogle上の店舗を選んでください"));
      check(
        "A: オーナー確認が無い店は理由と次の行動(オーナー確認・Googleの管理画面)つきで選べない",
        picker.includes("オーナー確認が必要です") && picker.includes("オーナー確認を完了すると、選択できます") && picker.includes("Googleの管理画面を開く"),
      );
      check("A: 店舗一覧の再読み込みと、接続の解除(削除を伴う操作の名前)がある", picker.includes("店舗一覧を再読み込み") && picker.includes("口コミ用Googleアカウントの接続を解除"));
      await shot(page, "pc-a-02-picker");
      await pickLocation(page, "locations/sim-101");
      const inbox = await bodyText(page);
      check("A: 選ぶと取り込み、口コミ数・平均は Google の値(4件・3.5)", inbox.includes("4件") && inbox.includes("3.5"));
      check("A: 既定の絞り込みは未返信(返信の無い2件)", inbox.includes("カットの相談") && inbox.includes("写真つき") && !inbox.includes("予約の時間から少し待ちました"));
      check("A: 口コミ数・平均評価が Google の値であることは、1回だけ出す", inbox.split("Google上の値").length - 1 === 1);
      const pill = await page.getByRole("radio", { name: "未返信" }).first().boundingBox();
      const select = await page.locator('select[aria-label="評価で絞り込む"]').boundingBox();
      check("A: PC では絞り込み(状態・評価・並び順)が1行に収まる", !!pill && !!select && Math.abs(pill.y + pill.height / 2 - (select.y + select.height / 2)) < 8, JSON.stringify({ pill, select }));
      check("A: 評価の絞り込みは「すべての評価」", (await page.locator('select[aria-label="評価で絞り込む"]').innerText()).includes("すべての評価"));
      await shot(page, "pc-a-03-inbox");
    });

    await scenario("A: AI の返信案・編集・再生成・投稿", () => page, async () => {
      await openReview(page, "カットの相談");
      const editor = await bodyText(page);
      check(
        "A: 返信の欄は「返信を作成」と短い説明。AI の詳しい説明は「AIの利用について」にまとめる",
        editor.includes("返信を作成") && editor.includes("内容を確認してからGoogleに投稿できます") && editor.includes("AIの利用について") && !editor.includes("伏せて送ります"),
      );
      check("A: 返信欄が空のときのボタンは「返信案を作成」(「AIで」を付けない)", (await page.getByRole("button", { name: "返信案を作成", exact: true }).count()) === 1);
      await page.getByRole("button", { name: "返信案を作成", exact: true }).click();
      await page.getByRole("button", { name: "作り直す", exact: true }).waitFor({ timeout: 60_000 });
      const first = await composerText(page).inputValue();
      check("A: 空欄から返信案を作成すると返信欄に入り、ボタンは「作り直す」になる。戻す文章は無い", first.startsWith("【検証用の架空の返信案】") && (await page.getByRole("button", { name: "前の文章に戻す" }).count()) === 0, first.slice(0, 40));
      // 未編集の返信案は、確認なしで作り直せる
      await page.getByRole("button", { name: "作り直す", exact: true }).click();
      await page.waitForTimeout(300);
      const noDialog = (await page.locator("dialog[open]").count()) === 0;
      await page.getByRole("button", { name: "前の文章に戻す" }).waitFor({ timeout: 60_000 });
      const second = await composerText(page).inputValue();
      check("A: 未編集の返信案は確認なしで作り直せ、同じ返信欄に入る(前の文章に戻せる)", noDialog && second !== first && second.startsWith("【検証用の架空の返信案】"));
      // 手直しした文章:確認が出て、キャンセルでは何も変えない
      await composerText(page).fill(`${second}(手直し)`);
      await waitText(page, "下書き保存済み");
      check("A: 自動で保存し「下書き保存済み」と保存の期限(最後の保存から25日)を出す", (await bodyText(page)).includes("まで保存されます(最後の保存から25日)"));
      await page.getByRole("button", { name: "作り直す", exact: true }).click();
      const confirmText = await page.locator("dialog[open]").innerText();
      check(
        "A: 手直しした文章を作り直すときは「編集中の文章を作り直しますか？」の確認が出る",
        confirmText.includes("編集中の文章を作り直しますか？") && confirmText.includes("新しい返信案に置き換えます。置き換え後も、前の文章に戻せます。"),
      );
      await shot(page, "pc-a-04-regenerate-confirm");
      await page.locator("dialog[open]").getByRole("button", { name: "キャンセル" }).click();
      check("A: キャンセルすると、元の文章がそのまま残る", (await composerText(page).inputValue()) === `${second}(手直し)`);
      // 作り直す → 前の文章に戻す(自動保存にも反映)
      await page.getByRole("button", { name: "作り直す", exact: true }).click();
      await page.locator("dialog[open]").getByRole("button", { name: "作り直す" }).click();
      for (let i = 0; i < 100 && (await composerText(page).inputValue()).endsWith("(手直し)"); i++) await page.waitForTimeout(300);
      const third = await composerText(page).inputValue();
      check(
        "A: 確認して作り直すと同じ返信欄が新しい案に置き換わり、第二の案の枠・コピーのボタンは無い",
        !third.endsWith("(手直し)") &&
          third.startsWith("【検証用の架空の返信案】") &&
          (await page.getByRole("region", { name: "新しいAI返信案" }).count()) === 0 &&
          (await page.getByRole("button", { name: /コピー/ }).count()) === 0 &&
          (await page.locator("article textarea").count()) === 1,
      );
      await shot(page, "pc-a-04-ai-alternative");
      await page.getByRole("button", { name: "前の文章に戻す" }).click();
      check("A: 「前の文章に戻す」で手直しした文章が同じ返信欄に戻る", (await composerText(page).inputValue()) === `${second}(手直し)`);
      await waitText(page, "下書き保存済み");
      await page.reload();
      await page.getByRole("button", { name: "作り直す", exact: true }).waitFor({ timeout: 60_000 });
      check("A: 戻した文章が自動で保存されている(読み込み直しても同じ)", (await composerText(page).inputValue()) === `${second}(手直し)`);
      await page.getByRole("button", { name: "返信内容を確認" }).first().click();
      const dialog = await page.locator("dialog[open]").innerText();
      check(
        "A: 確認のダイアログは「この内容でGoogleに投稿しますか？」。投稿先の Google の店舗名と SalonPack の店舗名の関係・口コミ・全文が出る",
        dialog.includes("この内容でGoogleに投稿しますか？") &&
          dialog.includes("架空のサロン 渋谷店") &&
          dialog.includes("SalonPackの「架空サロン 表参道店」と連携しているGoogleの店舗です") &&
          dialog.includes("カットの相談") &&
          dialog.includes(`${second}(手直し)`) &&
          dialog.includes("編集に戻る"),
        dialog.slice(0, 300),
      );
      await shot(page, "pc-a-05-confirm-dialog");
      await sendFromDialog(page, "Googleに投稿する");
      await waitText(page, "Googleが返信を受け付けました");
      check("A: 受け付けのあとは、一覧の行が「送信結果を確認中」、詳細は受け付けの案内を1回だけ", (await bodyText(page)).includes("送信結果を確認中") && (await countInDetail(page, "Googleが返信を受け付けました")) === 1);
      await page.getByRole("button", { name: "反映状況を再確認" }).first().click();
      await waitText(page, "審査中");
      await ctl(page, { action: "set_reply_state", reviewName: "accounts/sim-1/locations/sim-101/reviews/sim-r1", state: "APPROVED" });
      await page.getByRole("button", { name: "反映状況を再確認" }).first().click();
      await waitText(page, "公開済み");
      check("A: 「反映状況を再確認」で確かめると審査中 → 公開済み", true);
      await shot(page, "pc-a-06-approved");
      // 返信がある口コミ:返信と「返信を編集」が中心。入力欄は編集を選んだときに開く
      await page.goto(`${BASE}/dashboard/reviews/google?filter=replied`);
      await openReview(page, "カットの相談");
      const existing = await bodyText(page);
      check(
        "A: 返信がある口コミは、返信と「返信を編集」を出し、入力欄は開かない。削除は「その他の操作」の中",
        (await page.getByRole("button", { name: "返信を編集" }).count()) === 1 &&
          (await page.locator("article textarea").count()) === 0 &&
          existing.includes("その他の操作") &&
          !(await page.getByRole("button", { name: /削除/ }).first().isVisible().catch(() => false)),
      );
      await page.getByRole("button", { name: "返信を編集" }).click();
      check(
        "A: 「返信を編集」で、今の返信が入った入力欄が開く(変えるまでは変更内容を確認できない)",
        (await composerText(page).inputValue()).endsWith("(手直し)") && (await bodyText(page)).includes("文章を変更すると、変更内容を確認できます"),
      );
      await composerText(page).fill("書き直した返信(架空)");
      await page.getByRole("button", { name: "変更内容を確認" }).click();
      const change = await page.locator("dialog[open]").innerText();
      check("A: 既存の返信の変更は「この内容で返信を変更しますか？」「変更を投稿する」", change.includes("この内容で返信を変更しますか？") && change.includes("変更を投稿する") && change.includes("今の返信"));
      await shot(page, "pc-a-06b-edit-existing");
      await page.locator("dialog[open]").getByRole("button", { name: "編集に戻る" }).click();
      await page.getByRole("button", { name: "編集をやめる" }).click();
      await page.getByRole("button", { name: "返信を編集" }).waitFor();
      check("A: 「編集をやめる」で入力欄を閉じ、書き直した文章は下書きとして残る", (await bodyText(page)).includes("編集中の下書きがあります"));
    });

    await scenario("A: 結果不明と、遅れて最初の返信が反映される場合", () => page, async () => {
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await openReview(page, "写真つき");
      await composerText(page).fill("遅れて届く返信(架空)");
      await ctl(page, { action: "defer_next_write", operation: "reply" });
      const photo = await bodyText(page);
      check(
        "A: 写真を読み込めないときは、大きな枠を残さず「写真を読み込めませんでした」と再読み込みを出す",
        photo.includes("写真を読み込めませんでした") && photo.includes("再読み込み") && !photo.includes("画像を表示できません"),
      );
      await page.getByRole("button", { name: "返信内容を確認" }).first().click();
      await sendFromDialog(page, "Googleに投稿する");
      await waitText(page, "反映を確認できていません");
      const panel = await bodyText(page);
      const sendButtons = await page.getByRole("button", { name: /返信内容を確認|変更内容を確認|もう一度送る|送るのをやめる|削除|返信を編集|返信案を作成|作り直す/ }).count();
      check("A: 結果不明は「反映を確認できていません」。再送・変更・削除・AI・編集の操作は出さない", sendButtons === 0 && (await page.locator("article textarea").count()) === 0, panel.slice(0, 200));
      check(
        "A: 結果不明の説明は1か所だけ。送れなかったとは言わず、反映に時間がかかること・確認できるまで再送などできないこと・送信した返信・最終確認を出す",
        (await countInDetail(page, "反映を確認できていません")) === 1 &&
          panel.includes("反映に時間がかかることがあります") &&
          panel.includes("再送・変更・削除はできません") &&
          panel.includes("送信した返信") &&
          panel.includes("最終確認") &&
          panel.includes("Googleの管理画面を開く") &&
          !panel.includes("送信できませんでした"),
      );
      await shot(page, "pc-a-07-unconfirmed");
      await page.getByRole("button", { name: "反映状況を再確認" }).first().click();
      await waitText(page, "この時点では反映を確認できませんでした");
      check("A: 確認しても見えない間は、結果不明のまま(確認した時刻を出す)", (await bodyText(page)).includes("反映を確認できていません"));
      await shot(page, "pc-a-08-unconfirmed-after-check");
      const applied = await ctl(page, { action: "apply_deferred_writes" });
      check("A: 架空の Google で、最初の返信が遅れて反映された", applied.applied === 1);
      await page.getByRole("button", { name: "反映状況を再確認" }).first().click();
      await waitText(page, "審査中");
      const reply = await simState(page, "accounts/sim-1/locations/sim-101/reviews/sim-r4");
      check("A: 確認すると、遅れて反映された最初の返信を確認済み(審査中)にする。二重には送っていない", reply.reply?.comment === "遅れて届く返信(架空)" && reply.calls.filter((c) => c === "reply").length === 2);
      await shot(page, "pc-a-09-confirmed-after-delay");
    });

    await scenario("A: 公開できなかった返信・置き換えの失敗・競合", () => page, async () => {
      await page.goto(`${BASE}/dashboard/reviews/google?filter=attention`);
      await openReview(page, "予約の時間から少し待ちました");
      const rejected = await bodyText(page);
      check(
        "A: 公開できなかった返信は、Google が返した理由だけを短く出し、見出し・説明を重ねない",
        rejected.includes("理由:") && rejected.includes("口コミと関係のない内容") && (await countInDetail(page, "公開できませんでした")) === 1,
      );
      check("A: 公開できなかった返信では「返信を編集」を主な操作にする", (await page.getByRole("button", { name: "返信を編集" }).count()) === 1);
      check("A: 「確認が必要」を選ぶと、対象の状態を短く説明する", rejected.includes("送信中・反映の確認待ち・変更や削除の失敗・公開されなかった返信がある口コミです"));
      await shot(page, "pc-a-10-rejected");
      await page.goto(`${BASE}/dashboard/reviews/google?filter=replied`);
      await openReview(page, "架空 太郎");
      await page.getByRole("button", { name: "返信を編集" }).click();
      await composerText(page).fill("置き換えの返信(架空)");
      await ctl(page, { action: "fail_next", operation: "reply", kind: "permission_denied" });
      await page.getByRole("button", { name: "変更内容を確認" }).first().click();
      await sendFromDialog(page, "変更を投稿する");
      await waitText(page, "以前の返信がGoogleに残っています");
      const failed = await bodyText(page);
      check("A: 変更に失敗すると、残っている返信と編集中の文章を並べる", failed.includes("Googleに残っている返信") && failed.includes("置き換えの返信(架空)"));
      await shot(page, "pc-a-11-replace-failed");
      await page.getByRole("button", { name: "変更をやめる" }).click();
      await page.getByText("以前の返信がGoogleに残っています").first().waitFor({ state: "hidden", timeout: 30_000 });
      check("A: 「変更をやめる」で表示が戻る(Google には何も送らない)", (await simState(page)).calls.filter((c) => c === "reply").length === 3);
      await composerText(page).fill("競合の確認(架空)");
      await page.getByRole("button", { name: "変更内容を確認" }).first().click();
      await page.locator("dialog[open]").waitFor();
      await ctl(page, { action: "set_reply_externally", reviewName: "accounts/sim-1/locations/sim-101/reviews/sim-r3", comment: "(架空)Googleの画面で書き換えた返信" });
      await sendFromDialog(page, "変更を投稿する");
      await waitText(page, "Google上の返信が、確認したときから変わっていました");
      const after = await simState(page, "accounts/sim-1/locations/sim-101/reviews/sim-r3");
      check("A: 外で返信が変わっていたら送らずに知らせる(競合)", after.reply?.comment === "(架空)Googleの画面で書き換えた返信");
      await shot(page, "pc-a-12-conflict");
      await page.getByRole("button", { name: "Googleの返信をもとに編集し直す" }).click();
      check("A: 競合のあと Google の返信をもとに編集し直すと、返信欄は1つのまま Google の返信が入る", (await composerText(page).inputValue()) === "(架空)Googleの画面で書き換えた返信" && (await page.locator("article textarea").count()) === 1);
      await page.getByRole("button", { name: "前の文章に戻す" }).click();
      check("A: 競合の前に編集していた文章は「前の文章に戻す」で戻せる", (await composerText(page).inputValue()) === "競合の確認(架空)");
    });

    await scenario("A: 処理の重なり(返信案の作成中・送る直前の店舗の変更)", () => page, async () => {
      await ctl(page, { action: "add_review", locationName: "locations/sim-101", starRating: "FOUR", comment: "(架空)重なりの確認に使う口コミ" });
      // 店舗を選び直して、足した口コミを取り込む
      const other = await pc.newPage();
      await changeLocation(other);
      await pickLocation(other, "locations/sim-101");
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await openReview(page, "重なりの確認に使う口コミ");
      await ctl(page, { action: "delay_next_ai", ms: 12_000 });
      await page.getByRole("button", { name: "返信案を作成", exact: true }).click();
      await changeLocation(other);
      await waitText(page, "連携先が変更されました", 60_000);
      check(
        "A: 返信案の作成中に店舗を変えると、案を表示せず「一覧を読み込み直す」を出す",
        !(await composerText(page).inputValue()).includes("【検証用の架空の返信案】") && (await page.getByRole("button", { name: "一覧を読み込み直す" }).count()) > 0,
      );
      await shot(page, "pc-a-13-ai-stale");
      await pickLocation(other, "locations/sim-101");
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await openReview(page, "重なりの確認に使う口コミ");
      await composerText(page).fill("古い画面からの返信(架空)");
      await ctl(page, { action: "delay_next", operation: "review", ms: 12_000 });
      await page.getByRole("button", { name: "返信内容を確認" }).first().click();
      await sendFromDialog(page, "Googleに投稿する");
      await page.waitForTimeout(1500);
      await changeLocation(other);
      await waitText(page, "返信は送っていません", 60_000);
      const names = await simState(page);
      check(
        "A: 送る直前に店舗を変えると、送らない(架空の Google に返信の書き込みが無い)。読み込み直すと文章が消えることを先に伝える",
        names.calls.filter((c) => c === "reply").length === 3 &&
          (await bodyText(page)).includes("読み込み直すと消えます") &&
          (await page.getByRole("button", { name: "一覧を読み込み直す" }).count()) > 0,
      );
      await shot(page, "pc-a-14-send-stale");
      await pickLocation(other, "locations/sim-101");
      await other.close();
    });

    await scenario("A: 取り込み中の利用の停止と、再連携", () => page, async () => {
      const other = await pc.newPage();
      await ctl(page, { action: "add_review", locationName: "locations/sim-101", starRating: "FIVE", comment: "(架空)スマートフォンで確認する口コミ" });
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await ctl(page, { action: "delay_next", operation: "reviews", ms: 12_000 });
      // 選んだ直後は［更新］が5分の間隔で止まるため、店舗の変更で取り込みを走らせる代わりに、停止は取り込みの途中に入れる
      await changeLocation(other);
      const picking = (async () => {
        await other.locator(`input[type=radio][value="locations/sim-101"]`).check();
        await other.getByRole("button", { name: "この店舗と連携する" }).click();
      })();
      await page.waitForTimeout(3000);
      const stopper = await pc.newPage();
      await stopper.goto(`${BASE}/dashboard/settings/google`);
      await stopper.locator("details", { hasText: "Google口コミの利用を停止する" }).locator("summary").click();
      await stopper.getByRole("button", { name: "Google口コミの利用を停止する" }).click();
      await waitText(stopper, "Google口コミの利用を停止しました");
      await picking.catch(() => undefined);
      await other.waitForLoadState("networkidle");
      const { count } = await admin.from("gbp_review_index").select("id", { count: "exact", head: true }).eq("salon_id", shopA.salonId);
      check("A: 取り込みの途中で利用を停止すると、取り込んだ内容を書き戻さない(索引0件)", (count ?? 0) === 0, String(count));
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await waitText(page, "口コミ機能を使う前に");
      check("A: 停止のあとは未接続の案内に戻る", true);
      await stopper.close();
      await other.close();
      // 再連携(同意は記録済みでも、連携の開始にはチェックが要る)
      await page.getByText("上記の取り扱いに同意します").click();
      await page.getByRole("button", { name: "同意してGoogleと接続する" }).click();
      await approveOnSimulatedGoogle(page, "owner@example.test", /\/dashboard\/reviews\/google/);
      await waitText(page, "連携する店舗を選んでください");
      await pickLocation(page, "locations/sim-101");
      check("A: 再連携して店舗を選ぶと、また使える", (await bodyText(page)).includes("スマートフォンで確認する口コミ"));
    });

    // ================= B店(SalonPack・許可あり) =================
    const pcB = await browser.newContext(PC);
    watch(pcB);
    const pb = await pcB.newPage();
    await scenario("B: 共通の Google 連携の画面から連携 → 同意の確認 → 店舗", () => pb, async () => {
      await login(pb, shopB.email, shopB.password);
      const reviewsCard = pb.locator('[data-feature="reviews"]');
      await reviewsCard.waitFor({ timeout: 60_000 });
      const cardText = await reviewsCard.innerText();
      check("B: ホームの「口コミ」のカードは、アンケートが無くても「設定が必要」にせず「口コミを使う」", cardText.includes("口コミを使う") && !cardText.includes("設定が必要"), cardText.slice(0, 120));
      await shot(pb, "pc-b-00-home");
      await reviewsCard.getByRole("link", { name: "口コミを使う" }).click();
      await pb.waitForURL(/\/dashboard\/reviews\/google$/, { timeout: 60_000 });
      await pb.locator(TAB_NAV).waitFor({ timeout: 60_000 });
      check("B: SalonPack のホームから「口コミ」を開くと「口コミ」タブ", (await tabLabels(pb)).join("|") === "口コミ|アンケート|設定" && (await activeTab(pb)) === "口コミ");
      check("B: 左のメニューの「口コミ」も「口コミ」タブを開く", (await menuReviews(pb, "side").getAttribute("href")) === "/dashboard/reviews/google");
      await pb.goto(`${BASE}/dashboard/settings/google`);
      await pb.getByRole("button", { name: "同じGoogleアカウントでまとめて連携" }).click();
      const consent = await approveOnSimulatedGoogle(pb, "owner@example.test", /\/dashboard\/settings\/google/);
      check("B: 共通の画面では、予約メールと口コミの権限をまとめて求める", consent.includes("gmail") && consent.includes("business.manage"));
      const before = (await simState(pb)).calls.length;
      await pb.goto(`${BASE}/dashboard/reviews/google`);
      await waitText(pb, "口コミ機能を使う前に");
      const calls = (await simState(pb)).calls.slice(before);
      check("B: 同意の前は、店舗の候補も口コミも Google から取らない", !calls.some((c) => ["accounts", "locations", "reviews", "review"].includes(c)), calls.join(","));
      await shot(pb, "pc-b-01-consent-required");
      // 解除の説明は「口コミ用Googleアカウントの接続を解除」を開いたときに出る
      await pb.locator("details", { hasText: "口コミ用Googleアカウントの接続を解除" }).first().locator("summary").click();
      const consentScreen = await bodyText(pb);
      check(
        "B: 同意の画面は「上記の取り扱いに同意します」「同意して店舗を選ぶ」。予約通知の Gmail を連携している店舗には、解除しても Gmail が変わらないことを出す",
        consentScreen.includes("上記の取り扱いに同意します") && (await pb.getByRole("button", { name: "同意して店舗を選ぶ" }).count()) === 1 && consentScreen.includes("予約通知のGmail連携は変わりません"),
      );
      await pb.getByRole("button", { name: "同意して店舗を選ぶ" }).click();
      await pb.waitForTimeout(800);
      check("B: チェックが無いと、同意を記録しない(画面にとどまる)", (await bodyText(pb)).includes("上記の取り扱いに同意します"));
      await pb.getByText("上記の取り扱いに同意します").click();
      await pb.getByRole("button", { name: "同意して店舗を選ぶ" }).click();
      await waitText(pb, "連携する店舗を選んでください");
      const picker = await bodyText(pb);
      check("B: ほかの店舗が使っている店舗は理由と次の行動つきで選べない", picker.includes("SalonPackの別の店舗と連携済みです") && picker.includes("接続を解除すると、選択できます"));
      check("B: 予約通知の Gmail を連携している店舗には、別のアカウントでもよいことを短く出す", picker.includes("予約通知のGmailと別のGoogleアカウントでもかまいません"));
      await pb.getByRole("button", { name: "Googleアカウントを変更する" }).click();
      await approveOnSimulatedGoogle(pb, "staff@example.test", /\/dashboard\/reviews\/google/);
      await waitText(pb, "連携できる店舗が見つかりませんでした");
      const none = await bodyText(pb);
      check(
        "B: 店舗0件は「連携できる店舗が見つかりませんでした」・接続中のアカウント・アカウントの変更と再読み込み。成功の案内や「店舗を選んでください」は出さない",
        none.includes("接続中:staff@example.test") &&
          none.includes("Googleアカウントを変更する") &&
          none.includes("店舗一覧を再読み込み") &&
          none.includes("店舗が見つからない場合") &&
          !none.includes("連携する店舗を選んでください") &&
          !none.includes("連携が完了"),
      );
      await shot(pb, "pc-b-02-no-business");
      await pb.getByRole("button", { name: "店舗一覧を再読み込み" }).click();
      await pb.waitForLoadState("networkidle");
      await waitText(pb, "連携できる店舗が見つかりませんでした");
      check("B: 「店舗一覧を再読み込み」で取り直しても、0件の表示のまま(取得の失敗とは区別する)", !(await bodyText(pb)).includes("店舗の一覧を取得できませんでした"));
      await pb.getByRole("button", { name: "Googleアカウントを変更する" }).click();
      await approveOnSimulatedGoogle(pb, "owner@example.test", /\/dashboard\/reviews\/google/);
      await waitText(pb, "連携する店舗を選んでください");
      await pickLocation(pb, "locations/sim-201");
      const zero = await bodyText(pb);
      check("B: 口コミ0件の店:「まだGoogle口コミはありません」、口コミ数は 0件、平均は —", zero.includes("まだGoogle口コミはありません") && zero.includes("0件") && zero.includes("—"));
      await shot(pb, "pc-b-03-zero-reviews");
    });

    await scenario("B: 取得の途中と続き・返信案の作成の失敗・取得の失敗", () => pb, async () => {
      await changeLocation(pb);
      await ctl(pb, { action: "delay_next", operation: "reviews", ms: 11_000 });
      await pickLocation(pb, "locations/sim-202");
      const partial = await bodyText(pb);
      check("B: 初回の取り込みが途中で区切られると、続きの案内を出す", partial.includes("続きを取得する") || partial.includes("取得の状況を確認する"), partial.slice(0, 300));
      await shot(pb, "pc-b-04-partial");
      // 失敗のあとは、続きの案内の代わりに失敗の説明と「もう一度試す」が出る
      const more = pb.getByRole("button", { name: /続きを取得する|取得の状況を確認する|もう一度試す/ }).first();
      // 取得の失敗は原因ごとに説明する(一覧は残す)。失敗のあとは、再試行の待ち(30秒)をおく
      await ctl(pb, { action: "fail_next", operation: "reviews", kind: "unavailable" });
      await more.click();
      await waitText(pb, "最新の口コミを取得できませんでした");
      await shot(pb, "pc-b-05-fetch-failed");
      await pb.waitForTimeout(31_000);
      await ctl(pb, { action: "fail_next", operation: "reviews", kind: "permission_denied" });
      await more.click();
      await waitText(pb, "この店舗を管理する権限を確認できません");
      check("B: 取得の失敗は原因ごとに説明し、一覧は残す(一時的な失敗・店舗の権限)", (await bodyText(pb)).includes("架空 利用者1"));
      await pb.waitForTimeout(31_000);
      await more.click();
      await pb.waitForTimeout(500);
      await pb.getByText(/続きを取得する|取得しています/).first().waitFor({ state: "hidden", timeout: 120_000 }).catch(() => undefined);
      await pb.waitForLoadState("networkidle");
      const { count } = await admin.from("gbp_review_index").select("id", { count: "exact", head: true }).eq("salon_id", shopB.salonId);
      check("B: 続きで全件(120件)を取り込む", count === 120, String(count));
      await pb.goto(`${BASE}/dashboard/reviews/google?filter=all`);
      await pb.getByText("120件").first().waitFor({ timeout: 60_000 });
      check("B: 初回の分は新着にしない", !(await bodyText(pb)).includes("新しい口コミが"));
      // 一覧の行(1ページ 20件)が描かれてから測る。読み込み中の表示のままでは確かめたことにならない
      const listSection = pb.locator('section[aria-label="口コミの一覧"]');
      await listSection.locator("li a").nth(19).waitFor({ timeout: 60_000 });
      const unreadRows = await listSection.locator("li .sr-only", { hasText: "未読" }).count();
      const height = await noExtraPageHeight(pb);
      console.log(`  (一覧の高さの確認:未読の行 ${unreadRows}・${height.detail})`);
      check(
        "B: 未読の口コミが多くても、PC の一覧の下に空白ができない(ページが中身より長くならない)",
        unreadRows >= 10 && height.ok,
        `未読の行 ${unreadRows}・${height.detail}`,
      );
      await shot(pb, "pc-b-05b-long-list");
      // 作成中:返信欄は読み取り専用・投稿の確認は押せない。作成中に別の口コミへ移っても、案はほかの口コミに入らない
      await openReview(pb, "予約の時間から少し待ちました");
      await ctl(pb, { action: "delay_next_ai", ms: 8_000 });
      await pb.getByRole("button", { name: "返信案を作成", exact: true }).click();
      await pb.getByRole("button", { name: "返信案を作成しています…" }).waitFor({ timeout: 10_000 });
      check(
        "B: 作成中は返信欄を読み取り専用にし、投稿の確認を押せない",
        (await composerText(pb).getAttribute("readonly")) !== null && (await pb.getByRole("button", { name: "返信内容を確認" }).getAttribute("disabled")) !== null,
      );
      await shot(pb, "pc-b-05c-generating");
      await openReview(pb, "生成失敗を試すための口コミ");
      await pb.waitForTimeout(10_000);
      check("B: 作成中に別の口コミへ移っても、返信案はほかの口コミに入らない", (await composerText(pb).inputValue()) === "");
      await composerText(pb).fill("手で書いた返信(架空)");
      await pb.getByRole("button", { name: "作り直す", exact: true }).click();
      await pb.locator("dialog[open]").getByRole("button", { name: "作り直す" }).click();
      await waitText(pb, "返信案を作成できませんでした");
      check(
        "B: 返信案の作成に失敗しても、返信欄の文章は残る(「入力した文章は残っています」と［もう一度作成］)",
        (await composerText(pb).inputValue()) === "手で書いた返信(架空)" &&
          (await bodyText(pb)).includes("入力した文章は残っています") &&
          (await pb.getByRole("button", { name: "もう一度作成" }).count()) === 1,
      );
      await shot(pb, "pc-b-06-ai-failed");
    });

    await scenario("B: 権限不足と、再連携が必要な状態", () => pb, async () => {
      await pb.goto(`${BASE}/dashboard/reviews/google?filter=all`);
      await openReview(pb, "生成失敗を試すための口コミ");
      await composerText(pb).fill("手で書いた返信(架空)");
      await pb.getByRole("button", { name: "返信内容を確認" }).first().click();
      await sendFromDialog(pb, "Googleに投稿する");
      await waitText(pb, "Googleが返信を受け付けました");
      await ctl(pb, { action: "fail_next", operation: "review", kind: "scope_insufficient" });
      await pb.getByRole("button", { name: "反映状況を再確認" }).first().click();
      await waitText(pb, "口コミの権限が足りません");
      await pb.goto(`${BASE}/dashboard/reviews/google`);
      await waitText(pb, "口コミの権限が足りません");
      const { data: bindings } = await admin.from("salon_google_bindings").select("feature, scope_missing_since").eq("salon_id", shopB.salonId);
      const gmail = bindings?.find((b) => b.feature === "gmail");
      check("B: 権限不足は口コミの結び付けにだけ記録する(Gmail は変えない)", gmail?.scope_missing_since === null && bindings?.find((b) => b.feature === "gbp")?.scope_missing_since !== null);
      await shot(pb, "pc-b-07-scope-missing");
      await pb.getByRole("button", { name: "権限を追加する" }).click();
      await approveOnSimulatedGoogle(pb, "owner@example.test", /\/dashboard\/reviews\/google/);
      await pb.getByText("口コミ数").first().waitFor({ timeout: 60_000 });
      check("B: 権限を追加すると、また使える", true);
      // 再連携が必要(確認用のデータの Google アカウントの状態を変える)
      const { data: gbp } = await admin.from("salon_google_bindings").select("google_account_id").eq("salon_id", shopB.salonId).eq("feature", "gbp").single();
      await admin.from("google_accounts").update({ auth_state: "needs_reauth" }).eq("id", gbp!.google_account_id);
      await pb.reload();
      await waitText(pb, "Googleとの再接続が必要です");
      await shot(pb, "pc-b-08-needs-reconnect");
      await pb.getByRole("button", { name: "Googleに再接続する" }).click();
      await approveOnSimulatedGoogle(pb, "owner@example.test", /\/dashboard\/reviews\/google/);
      await pb.getByText("口コミ数").first().waitFor({ timeout: 60_000 });
      const { data: acc } = await admin.from("google_accounts").select("auth_state").eq("id", gbp!.google_account_id).single();
      check("B: 再接続すると、また使える", acc?.auth_state === "active", acc?.auth_state);
    });

    // ================= C店(口コミプラン・許可なし) =================
    let pc3: Page | undefined;
    await scenario("C: 許可の無い店舗", () => pc3, async () => {
      const ctxC = await browser.newContext(PC);
      watch(ctxC);
      pc3 = await ctxC.newPage();
      const p3 = pc3;
      await login(p3, shopC.email, shopC.password);
      check("C: 許可の無い口コミプランの店舗は、今までどおり初期設定へ", /\/dashboard\/setup\/reviews/.test(p3.url()), p3.url());
      const res = await p3.goto(`${BASE}/dashboard/reviews/google`);
      await p3.waitForLoadState("networkidle");
      const notFound = await bodyText(p3);
      // ダッシュボードは読み込み中の表示を先に返すため、HTTP の状態は 200 のまま、画面が 404 になる(既存の画面と同じ)。
      check(
        "C: 「口コミ」タブの URL は 404 の画面になり、口コミの画面・連携の案内を出さない",
        /404|could not be found|見つかりません/.test(notFound) && !notFound.includes("口コミ機能を使う前に"),
        `status=${res?.status()} ${notFound.slice(0, 120)}`,
      );
      await p3.goto(`${BASE}/dashboard/reviews`);
      await p3.waitForLoadState("networkidle");
      check("C: 左のメニューの「口コミ」は今まで通りアンケート(/dashboard/reviews)", (await menuReviews(p3, "side").getAttribute("href")) === "/dashboard/reviews");
      check("C: アンケートが無ければ今まで通り初期設定へ進み、口コミのタブは出さない", /\/dashboard\/setup\/reviews/.test(p3.url()) && (await tabLabels(p3)).length === 0, p3.url());
      await ctxC.close();
    });

    // ================= スマートフォン(A店) =================
    let ppRef: Page | undefined;
    await scenario("スマートフォン(390px)", () => ppRef, async () => {
      const phone = await browser.newContext(PHONE);
      watch(phone);
      const pp = await phone.newPage();
      ppRef = pp;
      await login(pp, shopA.email, shopA.password);
      await pp.getByText("口コミ数").first().waitFor({ timeout: 60_000 });
      check("スマホ: ログイン後に「口コミ」タブ。タブは 口コミ | アンケート | 設定 の順", /\/dashboard\/reviews\/google$/.test(pp.url()) && (await tabLabels(pp)).join("|") === "口コミ|アンケート|設定");
      check("スマホ: 口コミの一覧で、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-01-inbox");
      await pp.locator(TAB_NAV).getByRole("link", { name: "アンケート" }).click();
      await pp.waitForURL(/\/dashboard\/reviews$/, { timeout: 60_000 });
      await waitText(pp, "アンケートを作成する");
      check("スマホ: 「アンケート」タブで、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-06-survey-tab");
      check("スマホ: 下のメニューの「口コミ」は「口コミ」タブを開き、アンケートでも選択中", (await menuReviews(pp, "bottom").getAttribute("href")) === "/dashboard/reviews/google" && (await menuReviews(pp, "bottom").getAttribute("aria-current")) === "page");
      await menuReviews(pp, "bottom").click();
      await pp.waitForURL(/\/dashboard\/reviews\/google$/, { timeout: 60_000 });
      await pp.getByText("口コミ数").first().waitFor({ timeout: 60_000 });
      await openReview(pp, "スマートフォンで確認する口コミ");
      check("スマホ: 詳細は全画面で「一覧へ」がある", await pp.getByRole("link", { name: "一覧へ" }).first().isVisible());
      check("スマホ: 詳細で、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-02-detail");
      await pp.getByRole("button", { name: "返信案を作成", exact: true }).click();
      await pp.getByRole("button", { name: "作り直す", exact: true }).waitFor({ timeout: 60_000 });
      await pp.getByRole("button", { name: "作り直す", exact: true }).click();
      await pp.getByRole("button", { name: "前の文章に戻す" }).waitFor({ timeout: 60_000 });
      check("スマホ: 作り直したあとも返信欄は1つで、「前の文章に戻す」が出る。横にはみ出さない", (await pp.locator("article textarea").count()) === 1 && (await noHorizontalScroll(pp)));
      await shot(pp, "sp-a-02b-regenerated");
      await ctl(pp, { action: "defer_next_write", operation: "reply" });
      await pp.getByRole("button", { name: "返信内容を確認" }).first().click();
      await pp.locator("dialog[open]").waitFor();
      check("スマホ: 確認のダイアログが画面の幅に収まる", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-03-confirm-dialog");
      await sendFromDialog(pp, "Googleに投稿する");
      await waitText(pp, "反映を確認できていません");
      check("スマホ: 結果不明の表示で、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-04-unconfirmed");
      await ctl(pp, { action: "apply_deferred_writes" });
      await pp.getByRole("button", { name: "反映状況を再確認" }).first().click();
      await waitText(pp, "審査中");
      check(
        "スマホ: 返信が確認できたら、返信と「返信を編集」を中心に出す(入力欄は閉じる)",
        (await pp.locator("article textarea").count()) === 0 && (await pp.getByRole("button", { name: "返信を編集" }).count()) === 1,
      );
      check("スマホ: 返信の表示で、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-04b-replied");
      await pp.getByRole("link", { name: "一覧へ" }).first().click();
      await pp.getByText("口コミ数").first().waitFor({ timeout: 60_000 });
      await pp.goto(`${BASE}/dashboard/reviews/settings`);
      await pp.getByText("Google連携").first().waitFor();
      check("スマホ: 設定のタブで、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-05-settings");
      await phone.close();
    });

    // テスト用の Supabase(ログイン)と、架空の写真の .invalid 以外への通信が無いこと(Google・OpenAI・LINE に出ない)
    const supabaseHost = new URL(childEnv.NEXT_PUBLIC_SUPABASE_URL).hostname;
    const unexpected = [...external].filter((h) => h !== supabaseHost && !h.endsWith(".invalid"));
    check(`ブラウザから Google・OpenAI・LINE などへの通信が無い(通信先:${[...external].join(", ") || "なし"})`, unexpected.length === 0, unexpected.join(","));
  } finally {
    await browser.close().catch(() => {});
    if (process.platform === "win32" && server.pid) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { shell: true });
    else server.kill();
    const removed = await cleanupData(admin).catch((e) => ({ users: -1, accounts: -1, errors: [String(e)] }));
    console.log(`片付け: 確認用のユーザー ${removed.users}・架空の Google のアカウント ${removed.accounts}${removed.errors.length ? `・失敗 ${removed.errors.join(" / ")}` : ""}`);
    if (removed.errors.length) check("片付け", false, removed.errors.join(" / "));
    writeFileSync(path.join(OUT, "reviews-check-results.json"), JSON.stringify(results, null, 2));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
