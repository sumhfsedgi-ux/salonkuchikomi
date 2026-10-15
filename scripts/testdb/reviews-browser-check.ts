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
  check(): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  inputValue(): Promise<string>;
  innerText(): Promise<string>;
  isVisible(): Promise<boolean>;
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

async function openReview(page: Page, text: string) {
  await page.locator("a", { hasText: text }).first().click();
  await page.getByRole("button", { name: /AIで(返信案を作る|別の案を作る)/ }).first().waitFor({ timeout: 60_000 });
}

const composerText = (page: Page) => page.locator("textarea").first();

async function pickLocation(page: Page, locationName: string) {
  await page.locator(`input[type=radio][value="${locationName}"]`).check();
  await page.getByRole("button", { name: "この店舗の口コミを受け取る" }).click();
  await page.getByText("口コミ数").first().waitFor({ timeout: 120_000 });
  await page.waitForLoadState("networkidle");
}

async function changeLocation(page: Page) {
  await page.goto(`${BASE}/dashboard/reviews/settings`);
  await page.getByText("口コミを受け取るビジネスを変更する").click();
  await page.getByText("一時保存した口コミと下書きが削除されることを確認しました").click();
  await page.getByRole("button", { name: "ビジネスを選び直す" }).click();
  await page.waitForURL(/\/dashboard\/reviews\/google/, { timeout: 60_000 });
  await page.getByRole("button", { name: "この店舗の口コミを受け取る" }).waitFor({ timeout: 60_000 });
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
  const shopA = await createShop(admin, { key: "a", name: "口コミ確認A店(口コミプラン)", plan: "reviews", allow: true });
  const shopB = await createShop(admin, { key: "b", name: "口コミ確認B店(SalonPack)", plan: "salonpack", allow: true });
  const shopC = await createShop(admin, { key: "c", name: "口コミ確認C店(許可なし)", plan: "reviews", allow: false });
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
      check("A: 口コミプランで許可ありは、ログイン後に届いた口コミへ(アンケートが無くても初期設定に飛ばない)", /\/dashboard\/reviews\/google/.test(page.url()), page.url());
      const nav = await page.locator("nav", { hasText: "口コミを集める" }).first().innerText();
      check("A: 口コミのタブは3つ(口コミを集める・届いた口コミ・設定)", ["口コミを集める", "届いた口コミ", "設定"].every((t) => nav.includes(t)), nav);
      await waitText(page, "Googleに届いた口コミを、ここで確認・返信できます");
      await shot(page, "pc-a-01-not-connected");
      await page.getByRole("button", { name: "Googleと連携する" }).click();
      await page.waitForTimeout(800);
      check("A: 同意のチェックが無いと、連携を始めない(画面にとどまる)", /\/dashboard\/reviews\/google/.test(page.url()) && !/simulated-authorize/.test(page.url()));
      await page.getByText("上の内容を確認しました").click();
      await page.getByRole("button", { name: "Googleと連携する" }).click();
      const consent = await approveOnSimulatedGoogle(page, "owner@example.test", /\/dashboard\/reviews\/google/);
      check("A: 口コミの権限だけを求める(Gmail の権限は求めない)", consent.includes("business.manage") && !consent.includes("gmail"));
      await waitText(page, "口コミを受け取るビジネスを選んでください");
      const picker = await bodyText(page);
      check("A: 店舗の候補にオーナー確認が無い店は理由つきで選べない", picker.includes("Googleでオーナー確認が済んでいないため選べません"));
      await shot(page, "pc-a-02-picker");
      await pickLocation(page, "locations/sim-101");
      const inbox = await bodyText(page);
      check("A: 選ぶと取り込み、口コミ数・平均は Google の値(4件・3.5)", inbox.includes("4件") && inbox.includes("3.5"));
      check("A: 既定の絞り込みは未返信(返信の無い2件)", inbox.includes("カットの相談") && inbox.includes("写真つき") && !inbox.includes("予約の時間から少し待ちました"));
      await shot(page, "pc-a-03-inbox");
    });

    await scenario("A: AI の返信案・編集・再生成・投稿", () => page, async () => {
      await openReview(page, "カットの相談");
      await page.getByRole("button", { name: "AIで返信案を作る" }).click();
      await page.getByRole("button", { name: "AIで別の案を作る" }).waitFor({ timeout: 60_000 });
      const first = await composerText(page).inputValue();
      check("A: AI の返信案(架空)が返信欄に入る", first.startsWith("【検証用の架空の返信案】"), first.slice(0, 40));
      await composerText(page).fill(`${first}(手直し)`);
      await page.getByRole("button", { name: "AIで別の案を作る" }).click();
      await page.getByText("別の案").first().waitFor({ timeout: 60_000 });
      check("A: 手直しした文章は上書きせず、新しい案は「別の案」として出す", (await composerText(page).inputValue()).endsWith("(手直し)"));
      await shot(page, "pc-a-04-ai-alternative");
      await page.getByRole("button", { name: "Googleに返信する" }).first().click();
      const dialog = await page.locator("dialog[open]").innerText();
      check("A: 確認のダイアログに店舗名と投稿する全文が出る", dialog.includes("口コミ確認A店") && dialog.includes("(手直し)"));
      await shot(page, "pc-a-05-confirm-dialog");
      await sendFromDialog(page, "Googleに返信する");
      await waitText(page, "Googleが返信を受け付けました");
      check("A: 受け付けのあとは「送信結果を確認中」", (await bodyText(page)).includes("送信結果を確認中"));
      await page.getByRole("button", { name: "Googleで確認する" }).first().click();
      await waitText(page, "審査中");
      await ctl(page, { action: "set_reply_state", reviewName: "accounts/sim-1/locations/sim-101/reviews/sim-r1", state: "APPROVED" });
      await page.getByRole("button", { name: "Googleで確認する" }).first().click();
      await waitText(page, "公開済み");
      check("A: Google で確かめると審査中 → 公開済み", true);
      await shot(page, "pc-a-06-approved");
    });

    await scenario("A: 結果不明と、遅れて最初の返信が反映される場合", () => page, async () => {
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await openReview(page, "写真つき");
      await composerText(page).fill("遅れて届く返信(架空)");
      await ctl(page, { action: "defer_next_write", operation: "reply" });
      await page.getByRole("button", { name: "Googleに返信する" }).first().click();
      await sendFromDialog(page, "Googleに返信する");
      await waitText(page, "反映を確認できていません");
      const panel = await bodyText(page);
      const sendButtons = await page.getByRole("button", { name: /Googleに返信する|もう一度送る|送るのをやめる|削除/ }).count();
      check("A: 結果不明は「反映を確認できていません」。もう一度送る・別の返信・削除・送るのをやめるは出さない", sendButtons === 0, panel.slice(0, 200));
      check("A: 結果不明の説明は、送れなかったとは言わず、遅れて反映されることがあると伝える", panel.includes("時間をおいてGoogleに反映されることがあります") && !panel.includes("送信できませんでした"));
      await shot(page, "pc-a-07-unconfirmed");
      await page.getByRole("button", { name: "Googleで確認する" }).first().click();
      await waitText(page, "まだ反映を確認できていません");
      check("A: 確認しても見えない間は、結果不明のまま(確認した時刻を出す)", (await bodyText(page)).includes("反映を確認できていません"));
      await shot(page, "pc-a-08-unconfirmed-after-check");
      const applied = await ctl(page, { action: "apply_deferred_writes" });
      check("A: 架空の Google で、最初の返信が遅れて反映された", applied.applied === 1);
      await page.getByRole("button", { name: "Googleで確認する" }).first().click();
      await waitText(page, "審査中");
      const reply = await simState(page, "accounts/sim-1/locations/sim-101/reviews/sim-r4");
      check("A: 確認すると、遅れて反映された最初の返信を確認済み(審査中)にする。二重には送っていない", reply.reply?.comment === "遅れて届く返信(架空)" && reply.calls.filter((c) => c === "reply").length === 2);
      await shot(page, "pc-a-09-confirmed-after-delay");
    });

    await scenario("A: 公開できなかった返信・置き換えの失敗・競合", () => page, async () => {
      await page.goto(`${BASE}/dashboard/reviews/google?filter=attention`);
      await openReview(page, "予約の時間から少し待ちました");
      const rejected = await bodyText(page);
      check("A: 公開できなかった返信は理由つきで出す", rejected.includes("公開できませんでした") && rejected.includes("口コミと関係のない内容"));
      await shot(page, "pc-a-10-rejected");
      await page.goto(`${BASE}/dashboard/reviews/google?filter=replied`);
      await openReview(page, "架空 太郎");
      await composerText(page).fill("置き換えの返信(架空)");
      await ctl(page, { action: "fail_next", operation: "reply", kind: "permission_denied" });
      await page.getByRole("button", { name: "Googleの返信を置き換える" }).first().click();
      await sendFromDialog(page, "置き換える");
      await waitText(page, "置き換えできませんでした");
      const failed = await bodyText(page);
      check("A: 置き換えに失敗すると、残っている返信と編集中の文章を並べる", failed.includes("Googleに残っている返信") && failed.includes("置き換えの返信(架空)"));
      await shot(page, "pc-a-11-replace-failed");
      await page.getByRole("button", { name: "置き換えをやめる" }).click();
      await page.getByText("置き換えできませんでした").first().waitFor({ state: "hidden", timeout: 30_000 });
      check("A: 「置き換えをやめる」で表示が戻る(Google には何も送らない)", (await simState(page)).calls.filter((c) => c === "reply").length === 3);
      await composerText(page).fill("競合の確認(架空)");
      await page.getByRole("button", { name: "Googleの返信を置き換える" }).first().click();
      await page.locator("dialog[open]").waitFor();
      await ctl(page, { action: "set_reply_externally", reviewName: "accounts/sim-1/locations/sim-101/reviews/sim-r3", comment: "(架空)Googleの画面で書き換えた返信" });
      await sendFromDialog(page, "置き換える");
      await waitText(page, "Google上の返信が、確認したときから変わっていました");
      const after = await simState(page, "accounts/sim-1/locations/sim-101/reviews/sim-r3");
      check("A: 外で返信が変わっていたら送らずに知らせる(競合)", after.reply?.comment === "(架空)Googleの画面で書き換えた返信");
      await shot(page, "pc-a-12-conflict");
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
      await page.getByRole("button", { name: "AIで返信案を作る" }).click();
      await changeLocation(other);
      await waitText(page, "返信案を表示しませんでした", 60_000);
      check("A: 返信案の作成中に店舗を変えると、案を表示しない", !(await composerText(page).inputValue()).includes("【検証用の架空の返信案】"));
      await shot(page, "pc-a-13-ai-stale");
      await pickLocation(other, "locations/sim-101");
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await openReview(page, "重なりの確認に使う口コミ");
      await composerText(page).fill("古い画面からの返信(架空)");
      await ctl(page, { action: "delay_next", operation: "review", ms: 12_000 });
      await page.getByRole("button", { name: "Googleに返信する" }).first().click();
      await sendFromDialog(page, "Googleに返信する");
      await page.waitForTimeout(1500);
      await changeLocation(other);
      await waitText(page, "返信は送っていません", 60_000);
      const names = await simState(page);
      check("A: 送る直前に店舗を変えると、送らない(架空の Google に返信の書き込みが無い)", names.calls.filter((c) => c === "reply").length === 3);
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
        await other.getByRole("button", { name: "この店舗の口コミを受け取る" }).click();
      })();
      await page.waitForTimeout(3000);
      const stopper = await pc.newPage();
      await stopper.goto(`${BASE}/dashboard/settings/google`);
      await stopper.locator("details", { hasText: "届いた口コミの利用を停止する" }).locator("summary").click();
      await stopper.getByRole("button", { name: "届いた口コミの利用を停止する" }).click();
      await waitText(stopper, "届いた口コミの利用を停止しました");
      await picking.catch(() => undefined);
      await other.waitForLoadState("networkidle");
      const { count } = await admin.from("gbp_review_index").select("id", { count: "exact", head: true }).eq("salon_id", shopA.salonId);
      check("A: 取り込みの途中で利用を停止すると、取り込んだ内容を書き戻さない(索引0件)", (count ?? 0) === 0, String(count));
      await page.goto(`${BASE}/dashboard/reviews/google`);
      await waitText(page, "Googleに届いた口コミを、ここで確認・返信できます");
      check("A: 停止のあとは未連携の案内に戻る", true);
      await stopper.close();
      await other.close();
      // 再連携(同意は記録済みでも、連携の開始にはチェックが要る)
      await page.getByText("上の内容を確認しました").click();
      await page.getByRole("button", { name: "Googleと連携する" }).click();
      await approveOnSimulatedGoogle(page, "owner@example.test", /\/dashboard\/reviews\/google/);
      await waitText(page, "口コミを受け取るビジネスを選んでください");
      await pickLocation(page, "locations/sim-101");
      check("A: 再連携して店舗を選ぶと、また使える", (await bodyText(page)).includes("スマートフォンで確認する口コミ"));
    });

    // ================= B店(SalonPack・許可あり) =================
    const pcB = await browser.newContext(PC);
    watch(pcB);
    const pb = await pcB.newPage();
    await scenario("B: 共通の Google 連携の画面から連携 → 同意の確認 → 店舗", () => pb, async () => {
      await login(pb, shopB.email, shopB.password);
      await pb.goto(`${BASE}/dashboard/reviews`);
      const nav = await pb.locator("nav", { hasText: "口コミを集める" }).first().innerText();
      check("B: SalonPack でも、許可があれば口コミのタブは3つ", ["届いた口コミ", "設定"].every((t) => nav.includes(t)), nav);
      await pb.goto(`${BASE}/dashboard/settings/google`);
      await pb.getByRole("button", { name: "同じGoogleアカウントでまとめて連携" }).click();
      const consent = await approveOnSimulatedGoogle(pb, "owner@example.test", /\/dashboard\/settings\/google/);
      check("B: 共通の画面では、予約メールと口コミの権限をまとめて求める", consent.includes("gmail") && consent.includes("business.manage"));
      const before = (await simState(pb)).calls.length;
      await pb.goto(`${BASE}/dashboard/reviews/google`);
      await waitText(pb, "口コミの取り扱いについて確認してください");
      const calls = (await simState(pb)).calls.slice(before);
      check("B: 同意の前は、店舗の候補も口コミも Google から取らない", !calls.some((c) => ["accounts", "locations", "reviews", "review"].includes(c)), calls.join(","));
      await shot(pb, "pc-b-01-consent-required");
      await pb.getByRole("button", { name: "確認して、店舗の選択へ進む" }).click();
      await pb.waitForTimeout(800);
      check("B: チェックが無いと、同意を記録しない(画面にとどまる)", (await bodyText(pb)).includes("口コミの取り扱いについて確認してください"));
      await pb.getByText("上の内容を確認しました").click();
      await pb.getByRole("button", { name: "確認して、店舗の選択へ進む" }).click();
      await waitText(pb, "口コミを受け取るビジネスを選んでください");
      const picker = await bodyText(pb);
      check("B: ほかの店舗が使っている店舗は理由つきで選べない", picker.includes("ほかの店舗と連携済みのため選べません"));
      await pb.getByRole("button", { name: "別のGoogleアカウントで確認する" }).click();
      await approveOnSimulatedGoogle(pb, "staff@example.test", /\/dashboard\/reviews\/google/);
      await waitText(pb, "このGoogleアカウントで管理しているビジネスが見つかりません");
      await shot(pb, "pc-b-02-no-business");
      await pb.getByRole("button", { name: "別のGoogleアカウントで確認する" }).click();
      await approveOnSimulatedGoogle(pb, "owner@example.test", /\/dashboard\/reviews\/google/);
      await waitText(pb, "口コミを受け取るビジネスを選んでください");
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
      await openReview(pb, "生成失敗を試すための口コミ");
      await composerText(pb).fill("手で書いた返信(架空)");
      await pb.getByRole("button", { name: "AIで返信案を作る" }).click();
      await waitText(pb, "返信案を作れませんでした");
      check("B: 返信案の作成に失敗しても、返信欄の文章は残る", (await composerText(pb).inputValue()) === "手で書いた返信(架空)");
      await shot(pb, "pc-b-06-ai-failed");
    });

    await scenario("B: 権限不足と、再連携が必要な状態", () => pb, async () => {
      await pb.goto(`${BASE}/dashboard/reviews/google?filter=all`);
      await openReview(pb, "生成失敗を試すための口コミ");
      await composerText(pb).fill("手で書いた返信(架空)");
      await pb.getByRole("button", { name: "Googleに返信する" }).first().click();
      await sendFromDialog(pb, "Googleに返信する");
      await waitText(pb, "Googleが返信を受け付けました");
      await ctl(pb, { action: "fail_next", operation: "review", kind: "scope_insufficient" });
      await pb.getByRole("button", { name: "Googleで確認する" }).first().click();
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
      await waitText(pb, "Googleとの連携の確認が必要です");
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
        "C: 届いた口コミの URL は 404 の画面になり、口コミの画面・連携の案内を出さない",
        /404|could not be found|見つかりません/.test(notFound) && !notFound.includes("Googleに届いた口コミを、ここで確認・返信できます"),
        `status=${res?.status()} ${notFound.slice(0, 120)}`,
      );
      await p3.goto(`${BASE}/dashboard/reviews`);
      const nav = await bodyText(p3);
      check("C: 口コミの画面に「届いた口コミ」「設定」のタブを出さない", !nav.includes("届いた口コミ"), nav.slice(0, 160));
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
      check("スマホ: 届いた口コミの一覧で、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-01-inbox");
      await openReview(pp, "スマートフォンで確認する口コミ");
      check("スマホ: 詳細は全画面で「一覧へ」がある", await pp.getByRole("link", { name: "一覧へ" }).first().isVisible());
      check("スマホ: 詳細で、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-02-detail");
      await pp.getByRole("button", { name: "AIで返信案を作る" }).click();
      await pp.getByRole("button", { name: "AIで別の案を作る" }).waitFor({ timeout: 60_000 });
      await ctl(pp, { action: "defer_next_write", operation: "reply" });
      await pp.getByRole("button", { name: "Googleに返信する" }).first().click();
      await pp.locator("dialog[open]").waitFor();
      check("スマホ: 確認のダイアログが画面の幅に収まる", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-03-confirm-dialog");
      await sendFromDialog(pp, "Googleに返信する");
      await waitText(pp, "反映を確認できていません");
      check("スマホ: 結果不明の表示で、ページが横にはみ出さない", await noHorizontalScroll(pp));
      await shot(pp, "sp-a-04-unconfirmed");
      await ctl(pp, { action: "apply_deferred_writes" });
      await pp.getByRole("button", { name: "Googleで確認する" }).first().click();
      await waitText(pp, "審査中");
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
