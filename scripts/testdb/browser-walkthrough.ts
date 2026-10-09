/**
 * 実際のブラウザでの画面確認(テスト用DB + 擬似 Google + 擬似 LINE ログイン)。開発サーバーをテスト用DBの設定で起動し、
 * インストール済みの Chrome(または Edge)を playwright-core で操作して確かめる:
 *   - オーナー(PC): ログイン・店舗情報・機能の選択・Google 連携・通知先の追加(招待のリンクと QR)・開始・解除・
 *     Gmail だけの権限不足と権限の追加
 *   - スタッフ(スマートフォンの画面サイズ・タッチ操作のエミュレーション): 招待のリンクを開く → 擬似 LINE ログインで
 *     キャンセル・友だち未追加からの再試行 → 登録 → 管理画面には入れない。同じ LINE での2つ目の招待は「登録済み」
 *   - 旧サービス利用店舗: 再接続後は「お客様の操作は以上です」。内部の「切り替え待ち」・開始ボタンを出さず、
 *     引き継いだ通知先・全体スイッチは変更できない。新しく追加した通知先は解除でき、運用状態は変わらない
 *   - --line-invites-disabled: LINE ログインが未有効の本番と同じ状態。通知先の追加は運営への問い合わせの案内になる
 *   - 同じスマートフォンのブラウザの別のタブで、A店・B店の招待を開いても取り違えない(開始・並行・逆順の戻り・
 *     キャンセルと再試行・再読み込み)
 *   - テスト通知(PC・スマートフォン): 押す前に「実際には送信しない」と出し、押すとシミュレーションの結果を出す
 * 本物の Google・LINE には接続しない。共有・本番の DB には接続しない(scripts/testdb/target.mjs で確認)。
 *
 * playwright-core はこのリポジトリの依存関係に入れていない(ブラウザは端末にインストール済みのものを使う)。
 *   npm i --no-save playwright-core   または   PLAYWRIGHT_CORE_PATH=<playwright-core の場所> を指定
 *   npx tsx scripts/testdb/browser-walkthrough.ts [--reviews-enabled] [--line-invites-disabled] [--channel=chrome|msedge] [--headed]
 * スクリーンショットは BROWSER_WALKTHROUGH_SHOTS(省略時は保存しない)。
 */
import { spawn, type ChildProcess } from "child_process";
import { pathToFileURL } from "url";
import { buildChildEnv, loadTestTarget } from "./target.mjs";

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const reviewsEnabled = process.argv.includes("--reviews-enabled");
const invitesDisabled = process.argv.includes("--line-invites-disabled");
const channel = process.argv.find((a) => a.startsWith("--channel="))?.split("=")[1] ?? "chrome";
const headed = process.argv.includes("--headed");
const shotsDir = process.env.BROWSER_WALKTHROUGH_SHOTS ?? null;
const shotPrefix = `${reviewsEnabled ? "reviews-" : ""}${invitesDisabled ? "noinvite-" : ""}`;
/** 検証用の問い合わせ先(.invalid のドメイン。本番では NEXT_PUBLIC_SUPPORT_CONTACT_URL に実際の連絡先を設定する)。 */
const TEST_SUPPORT_CONTACT = "mailto:support@example.invalid";

const target = loadTestTarget({ requireDatabaseUrl: true });
const childEnv = buildChildEnv(target, process.env, PORT) as Record<string, string>;
if (reviewsEnabled) childEnv.GOOGLE_REVIEWS_OAUTH_ENABLED = "1";
if (invitesDisabled) {
  childEnv.LINE_LOGIN_SIMULATED = "0";
  childEnv.NEXT_PUBLIC_SUPPORT_CONTACT_URL = TEST_SUPPORT_CONTACT;
  childEnv.NEXT_PUBLIC_SUPPORT_CONTACT_LABEL = "運営(検証用の連絡先)";
}
childEnv.NEXT_PUBLIC_APP_MODE = "salonpack";
for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;

// playwright-core の型をリポジトリに持ち込まないため、使う部分だけを宣言する。
interface Locator {
  click(): Promise<void>;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  isChecked(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>;
  first(): Locator;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  url(): string;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp): Locator;
  getByLabel(text: string | RegExp): Locator;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  reload(): Promise<unknown>;
  on(event: "dialog", handler: (dialog: { accept(): Promise<void> }) => void): void;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
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
  deviceScaleFactor: 3,
};

const results: Array<{ ok: boolean; label: string }> = [];
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

/** 開発サーバーは各ページを最初の表示のときにコンパイルするため、先に一度開いておく(クリックの待ち時間切れを避ける)。 */
async function warmUp() {
  for (const path of [
    "/dashboard",
    "/dashboard/notifications",
    "/dashboard/settings/google",
    "/line/invite",
    "/line/invite/continue",
    "/api/line/login/simulated-authorize",
    "/api/google/oauth/simulated-authorize",
  ]) {
    await fetch(`${BASE}${path}`, { redirect: "manual" }).catch(() => {});
  }
}

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.screenshot({ path: `${shotsDir}/${shotPrefix}${name}.png`, fullPage: true });
}

async function text(page: Page, selector = "main"): Promise<string> {
  return page.locator(selector).first().innerText();
}

/** 文言が出るまで待つ。出なければ、その時点の URL と本文の一部を添えて止める(原因を追えるように)。 */
async function waitText(page: Page, value: string, timeout = 60_000) {
  try {
    await page.getByText(value).first().waitFor({ timeout });
  } catch {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 400).replace(/\s+/g, " ");
    throw new Error(`「${value}」が表示されません(${page.url()}): ${body}`);
  }
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
}

/** 擬似 Google の同意画面で、アカウントを選んで「許可する」を押し、SalonPack に戻るまで待つ。 */
async function approveOnSimulatedGoogle(page: Page, accountEmail: string) {
  await page.waitForURL(/oauth\/simulated-authorize/, { timeout: 60_000 });
  const consent = await page.locator("body").innerText();
  await page.locator("label", { hasText: accountEmail }).locator("input[type=radio]").check();
  await page.getByRole("button", { name: "許可する" }).click();
  await page.waitForURL(/\/dashboard\/settings\/google/, { timeout: 60_000 });
  return consent;
}

/** 擬似 LINE ログインの画面で、アカウント・友だち追加を選び「許可する」か「キャンセル」を押し、結果ページまで待つ。 */
async function onSimulatedLine(page: Page, options: { account: string; addFriend?: boolean; cancel?: boolean }) {
  try {
    await page.waitForURL(/line\/login\/simulated-authorize/, { timeout: 60_000 });
  } catch {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 400).replace(/\s+/g, " ");
    throw new Error(`擬似LINEの画面に移りません(${page.url()}): ${body}`);
  }
  const body = await page.locator("body").innerText();
  await page.locator("label", { hasText: options.account }).locator("input[type=radio]").check();
  const friend = page.locator("input[name=add_friend]");
  if (options.addFriend === false) await friend.uncheck();
  else await friend.check();
  await page.getByRole("button", { name: options.cancel ? "キャンセル" : "許可する" }).click();
  await page.waitForURL(/\/line\/invite\/continue/, { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  return body;
}

/** 機能のカード(Google連携の画面)の本文。 */
async function featureCardText(page: Page, label: string): Promise<string> {
  const all = await text(page);
  const start = all.indexOf(`${label}\n`);
  if (start < 0) return "";
  const rest = all.slice(start);
  const next = ["予約通知\n", "届いた口コミ\n", "Google連携をすべて解除"]
    .filter((l) => !l.startsWith(label))
    .map((l) => rest.indexOf(l, label.length))
    .filter((i) => i > 0);
  return next.length ? rest.slice(0, Math.min(...next)) : rest;
}

const SIMULATED_TEST_SEND = "送信をシミュレーションしました（実際には送信していません）";

/** テスト通知: 押す前に「実際には送信しない」と出し、押すとシミュレーションの結果を出す。履歴に送信の記録を残さない。 */
async function checkSimulatedTestSend(page: Page, admin: AdminClient, salonId: string, device: string) {
  const notice = await page.locator("[data-testid=test-send-notice]").innerText();
  check(`テスト通知(${device}): 押す前に「この環境では実際には送信しない」と表示`, notice.includes("実際には送信しません"));
  await page.getByRole("button", { name: "テスト通知をシミュレーションする" }).click();
  await waitText(page, SIMULATED_TEST_SEND);
  await shot(page, `test-send-${device}`);
  const { count } = await admin.from("notification_history").select("id", { count: "exact", head: true }).eq("salon_id", salonId).eq("event_type", "test");
  check(`テスト通知(${device}): 「${SIMULATED_TEST_SEND}」と表示し、送信の記録を残さない`, count === 0);
}

type AdminClient = ReturnType<Awaited<typeof import("./notificationsFixtures")>["notificationsTestAdminClient"]>;

/**
 * 同じスマートフォンのブラウザ(同じ cookie)で、別のタブに別の店舗の招待を開いても取り違えないこと。
 * 表示した招待に、開始・LINE ログイン・戻り・結果・再試行・再読み込みが結び付いていることを、実際の画面で確かめる。
 */
async function multiTabInvites(browser: Browser, admin: AdminClient, cleanups: Array<() => Promise<void>>) {
  const { createTestSalon } = await import("./notificationsFixtures");
  const { generateInviteToken, hashInviteToken } = await import("@/lib/notifications/recipients/invites");
  const shopA = await createTestSalon({ plan: "salonpack" });
  const shopB = await createTestSalon({ plan: "salonpack" });
  cleanups.push(shopA.cleanup, shopB.cleanup);
  await admin.from("salons").update({ name: "A店" }).eq("id", shopA.salonId);
  await admin.from("salons").update({ name: "B店" }).eq("id", shopB.salonId);
  // A店のオーナーは、あとでスマートフォンからテスト通知を確かめる(機能の選択まで済んだ店舗にしておく)。
  await admin.from("salon_feature_selections").upsert({ salon_id: shopA.salonId, feature_key: "reservation_notifications", selected: true }, { onConflict: "salon_id,feature_key" });
  await admin.from("salon_setup_state").upsert({ salon_id: shopA.salonId, feature_selection_saved_at: new Date().toISOString() }, { onConflict: "salon_id" });
  const invite = async (salon: typeof shopA, name: string) => {
    const token = generateInviteToken();
    const { error } = await admin.rpc("line_invite_create", { p_salon_id: salon.salonId, p_token_hash: hashInviteToken(token), p_display_name: name, p_by: salon.userId });
    if (error) throw new Error(`招待を作れません: ${error.message}`);
    return `${BASE}/line/invite#${token}`;
  };
  const staffOf = async (salonId: string) => {
    const { data } = await admin.from("line_connections").select("label").eq("salon_id", salonId).is("removed_at", null);
    return (data ?? []).map((r) => r.label as string).sort();
  };

  const staff = await browser.newContext(PHONE);
  try {
    // ① A → B の順に別のタブで開き、A のタブから連携する。
    const tabA = await staff.newPage();
    await tabA.goto(await invite(shopA, "Aのスタッフ"));
    await waitText(tabA, "A店");
    const tabB = await staff.newPage();
    await tabB.goto(await invite(shopB, "Bのスタッフ"));
    await waitText(tabB, "B店");
    check("別タブ: 招待を開いたあとのアドレスは、その招待の進行(?f=)になる", /\/line\/invite\?f=[0-9a-f-]{36}$/.test(tabA.url()) && /\/line\/invite\?f=[0-9a-f-]{36}$/.test(tabB.url()) && tabA.url() !== tabB.url());
    await tabA.getByRole("button", { name: "LINEで連携する" }).click();
    await onSimulatedLine(tabA, { account: "スタッフA(擬似LINE)" });
    await shot(tabA, "13-tab-a-registered");
    check("別タブ: A → B の順に開いて A から連携 → A店に登録(あとから開いた B店にはならない)", (await text(tabA, "body")).includes("A店 の予約通知の通知先に追加されました"));
    check("別タブ: DB でも A店だけに登録され、B店には登録されない", JSON.stringify(await staffOf(shopA.salonId)) === JSON.stringify(["Aのスタッフ"]) && (await staffOf(shopB.salonId)).length === 0);
    check("別タブ: B のタブは B店の招待のまま", (await text(tabB, "body")).includes("B店"));

    // 再読み込み: どちらのタブも、別の招待に切り替わらない。
    await tabA.reload();
    await waitText(tabA, "追加されました");
    check("再読み込み: A のタブ(結果ページ)は A店の結果のまま", (await text(tabA, "body")).includes("A店 の予約通知の通知先に追加されました"));
    await tabB.reload();
    await waitText(tabB, "B店");
    const reloadedB = await text(tabB, "body");
    check("再読み込み: B のタブ(招待ページ)は B店の招待のまま(連携のボタンも B店)", reloadedB.includes("B店") && reloadedB.includes("Bのスタッフ") && !reloadedB.includes("A店") && tabB.url().includes("/line/invite/continue?f="));

    // ② A2・B2 の LINE ログインを並行して進め、逆の順(B2 → A2)で戻る。A2 はキャンセル → 再試行。
    const tabA2 = await staff.newPage();
    await tabA2.goto(await invite(shopA, "A2のスタッフ"));
    await waitText(tabA2, "A店");
    const tabB2 = await staff.newPage();
    await tabB2.goto(await invite(shopB, "B2のスタッフ"));
    await waitText(tabB2, "B店");
    await tabA2.getByRole("button", { name: "LINEで連携する" }).click();
    await tabA2.waitForURL(/line\/login\/simulated-authorize/, { timeout: 60_000 });
    await tabB2.getByRole("button", { name: "LINEで連携する" }).click();
    await onSimulatedLine(tabB2, { account: "スタッフB(擬似LINE)" });
    check("並行: あとから始めた B2 が先に戻っても B店に登録", (await text(tabB2, "body")).includes("B店 の予約通知の通知先に追加されました"));
    await onSimulatedLine(tabA2, { account: "スタッフB(擬似LINE)", cancel: true });
    const cancelledA2 = await text(tabA2, "body");
    check("並行: 先に始めた A2 はキャンセル → A店の招待のまま再試行を案内", cancelledA2.includes("キャンセルされました") && cancelledA2.includes("A店") && !cancelledA2.includes("B店"));
    await tabB2.reload();
    await waitText(tabB2, "追加されました");
    check("キャンセルは、もう一方(B2)の結果に影響しない", (await text(tabB2, "body")).includes("B店 の予約通知の通知先に追加されました"));
    await tabA2.getByRole("button", { name: "もう一度LINEで連携する" }).click();
    await onSimulatedLine(tabA2, { account: "スタッフB(擬似LINE)" });
    await shot(tabA2, "14-tab-a2-retried");
    check("再試行: A2 は A店に登録(B2 の結果は変わらない)", (await text(tabA2, "body")).includes("A店 の予約通知の通知先に追加されました"));
    await tabB2.reload();
    await waitText(tabB2, "追加されました");
    check("再試行のあとも B2 は B店の結果のまま", (await text(tabB2, "body")).includes("B店 の予約通知の通知先に追加されました"));
    const finalA = await staffOf(shopA.salonId);
    const finalB = await staffOf(shopB.salonId);
    check(
      "DB: A店 = A・A2 のスタッフ、B店 = B2 のスタッフ(取り違え・二重登録なし)",
      JSON.stringify(finalA) === JSON.stringify(["A2のスタッフ", "Aのスタッフ"].sort()) && JSON.stringify(finalB) === JSON.stringify(["B2のスタッフ"])
    );
  } finally {
    await staff.close();
  }

  // テスト通知(スマートフォン): A店のオーナーが、通知先のある画面で押す。
  const ownerPhone = await browser.newContext(PHONE);
  try {
    const ownerPage = await ownerPhone.newPage();
    await login(ownerPage, shopA.email, shopA.password);
    await ownerPage.goto(`${BASE}/dashboard/notifications`);
    await ownerPage.locator("[data-testid=test-send-notice]").waitFor({ timeout: 60_000 });
    await checkSimulatedTestSend(ownerPage, admin, shopA.salonId, "スマホ");
  } finally {
    await ownerPhone.close();
  }
}

/** オーナーが通知先の招待を作り、リンクを返す。 */
async function createInvite(page: Page, displayName: string): Promise<string> {
  await page.getByRole("button", { name: "通知先を追加" }).click();
  await page.locator("#invite-name").fill(displayName);
  await page.getByRole("button", { name: "招待を作成" }).click();
  await page.locator("[data-testid=issued-invite]").waitFor({ timeout: 60_000 });
  return page.getByLabel("招待のリンク").inputValue();
}

async function main() {
  const modulePath = process.env.PLAYWRIGHT_CORE_PATH;
  const spec = modulePath ? pathToFileURL(modulePath).href : "playwright-core";
  const pw = (await import(spec)) as Playwright & { default?: Playwright };
  const playwright: Playwright = pw.chromium ? pw : pw.default!;

  const { createTestSalon, notificationsTestAdminClient } = await import("./notificationsFixtures");
  const admin = notificationsTestAdminClient();
  const cleanups: Array<() => Promise<void>> = [];
  const server = startServer();
  const browser = await playwright.chromium.launch({ channel, headless: !headed });
  try {
    await waitForServer();
    await warmUp();
    console.log(
      `開発サーバー起動・ブラウザ(${channel}${headed ? "" : "・画面なし"})・テスト用DB・擬似Google・擬似LINEログイン ${invitesDisabled ? "未有効(本番と同じ)" : "有効"}・届いた口コミ ${reviewsEnabled ? "有効" : "準備中"}`
    );

    // ---------------- 新規のお客様(PC): 店舗情報 → 機能の選択 → Google 連携 ----------------
    const email = `browser-walk-${Date.now()}@example.invalid`;
    const password = `Walk${Math.random().toString(36).slice(2, 10)}!9`;
    const { data: created, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (userError || !created.user) throw new Error(`テストユーザーを作れません: ${userError?.message}`);
    const userId = created.user.id;
    cleanups.push(async () => {
      await admin.auth.admin.deleteUser(userId);
    });

    const context = await browser.newContext(PC);
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    await login(page, email, password);
    await page.getByText("店舗名").first().waitFor();
    await shot(page, "01-store-info");
    await page.locator("#onboarding-name").fill("ブラウザ確認サロン");
    await page.getByRole("button", { name: "次へ" }).click();
    const { data: profile } = await admin.from("profiles").select("id").eq("user_id", userId).single();
    type SalonRow = { id: string; plan: string };
    let salonRow = null as SalonRow | null;
    for (let i = 0; i < 60 && !salonRow; i++) {
      const { data } = await admin.from("salons").select("id, plan").eq("owner_id", profile!.id).maybeSingle();
      salonRow = (data as SalonRow | null) ?? null;
      if (!salonRow) await new Promise((r) => setTimeout(r, 500));
    }
    await page.waitForLoadState("networkidle");
    check("店舗情報の入力で店舗が作られる(契約は常に reviews で作成)", salonRow?.plan === "reviews");
    const salonId = salonRow!.id as string;

    // 運営が契約を確認して、予約通知を含む契約に変える(scripts/salon-contract.ts set-plan に相当)。
    await admin.from("salons").update({ plan: "salonpack" }).eq("id", salonId);
    await page.goto(`${BASE}/dashboard`);
    await page.getByText("使う機能を選びましょう").waitFor({ timeout: 60_000 });
    const selection = await text(page);
    check("機能の選択: 契約上使える機能を複数選べる(固定の3択ではない)", ["口コミ", "ブログ", "予約通知", "届いた口コミ"].every((l) => selection.includes(l)));
    const reviewsBox = page.locator("label", { hasText: "届いた口コミ" }).locator("input[type=checkbox]");
    await shot(page, "02-feature-selection");
    await page.locator("label", { hasText: "予約通知" }).locator("input[type=checkbox]").check();
    await page.locator("label", { hasText: "ブログ" }).locator("input[type=checkbox]").check();
    if (reviewsEnabled && (await reviewsBox.count()) > 0) await reviewsBox.check();
    await page.getByRole("button", { name: "次へ" }).click();
    await page.getByText("設定が必要な項目").waitFor({ timeout: 60_000 });
    const home = await text(page);
    await shot(page, "03-checklist");
    check("選んだ機能の未設定の項目だけを案内(口コミのアンケートは求めない)", home.includes("Googleと連携") && home.includes("LINEの通知先") && !home.includes("アンケート"));
    check(
      invitesDisabled ? "LINE ログイン未有効: LINE の項目は運営への問い合わせを案内(押せないボタンへ誘導しない)" : "LINE の項目は「通知先を追加」へ案内",
      invitesDisabled ? home.includes("運営にお問い合わせください") : home.includes("LINEの通知先を追加")
    );
    const { data: opsBefore } = await admin.from("reservation_notification_operations").select("state").eq("salon_id", salonId).maybeSingle();
    check("機能を選んだだけでは予約通知は始まらない", !opsBefore || opsBefore.state === "setup_pending");

    await page.locator("li", { hasText: "Googleと連携" }).getByRole("link", { name: "設定する" }).click();
    await page.waitForURL(/\/dashboard\/settings\/google/, { timeout: 60_000 });
    await page.getByText("Googleアカウント").first().waitFor({ timeout: 60_000 });
    if (reviewsEnabled) {
      const before = await text(page);
      check("予約通知と届いた口コミ: 同じアカウントでまとめて連携・別々に連携を選べる", before.includes("同じGoogleアカウントでまとめて連携") && before.includes("別々のアカウント"));
      await page.getByRole("button", { name: "同じGoogleアカウントでまとめて連携" }).click();
    } else {
      await page.getByRole("button", { name: "Googleと連携する" }).first().click();
    }
    const consent = await approveOnSimulatedGoogle(page, "owner@example.test");
    check("同意画面は prompt なし(通常の接続で同意を強制しない)", consent.includes("prompt: (なし)"));
    await page.getByText("Googleとの連携が完了しました").first().waitFor({ timeout: 60_000 });
    await shot(page, "05-google-connected");
    const reservationCard = await featureCardText(page, "予約通知");
    check("接続後: 予約通知のカードにアカウントと「許可済み」を表示", reservationCard.includes("owner@example.test") && reservationCard.includes("許可済み"));
    check(
      "接続後: 同意できたことと通知の開始を混同させない(次は LINE の通知先)",
      invitesDisabled ? reservationCard.includes("LINEの通知先の追加は、運営にお問い合わせください") : reservationCard.includes("LINEの通知先を追加してください")
    );
    if (reviewsEnabled) {
      check("届いた口コミ: 認証後も店舗の選択を省略しない", (await featureCardText(page, "届いた口コミ")).includes("口コミを受け取る店舗の選択が必要"));
    }

    await page.goto(`${BASE}/dashboard/notifications`);
    await page.getByText("LINEの通知先").first().waitFor({ timeout: 60_000 });
    const staffContexts: BrowserContext[] = [];
    if (invitesDisabled) {
      const notif = await text(page);
      await shot(page, "06-no-invites");
      check("LINE ログイン未有効: 「通知先を追加」は出さず、運営への問い合わせの導線を出す", !notif.includes("通知先を追加\n") && notif.includes("LINEの通知先の追加は準備中です"));
      const contactHref = await page.getByRole("link", { name: "運営(検証用の連絡先)" }).first().getAttribute("href");
      check("問い合わせの導線は、設定された実際の連絡先へのリンク", contactHref === TEST_SUPPORT_CONTACT);
      const staff = await browser.newContext(PHONE);
      staffContexts.push(staff);
      const staffPage = await staff.newPage();
      await staffPage.goto(`${BASE}/line/invite#${"x".repeat(43)}`);
      await staffPage.waitForLoadState("networkidle");
      check("LINE ログイン未有効: 招待ページは「ご利用いただけません」", (await text(staffPage, "body")).includes("ご利用いただけません"));
      // 運営が LINE の送信先を登録する(未有効の間の手順)。
      await admin.from("line_connections").insert({ salon_id: salonId, destination_id: "U_browser_walk", label: "スタッフ", status: "connected" });
      await page.reload();
    } else {
      // ---------------- 通知先の追加: オーナー(PC)が招待 → スタッフ(スマホ)が自分の LINE を連携 ----------------
      const link = await createInvite(page, "山田(スマホ)");
      await shot(page, "06-invite-issued");
      const qr = await page.locator("img[alt='招待のQRコード']").getAttribute("src");
      check("招待: リンクと QR コードを表示(値は URL のフラグメント)", /\/line\/invite#[A-Za-z0-9_-]{43}$/.test(link) && Boolean(qr?.startsWith("data:image/svg+xml")));

      const staff = await browser.newContext(PHONE);
      staffContexts.push(staff);
      const staffPage = await staff.newPage();
      await staffPage.goto(link);
      await waitText(staffPage, "の予約通知の通知先に");
      await shot(staffPage, "07-staff-invite");
      const invitePage = await text(staffPage, "body");
      check("スタッフ(スマホ): 店舗名と「予約の情報がLINEに届く」ことを確認できる", invitePage.includes("ブラウザ確認サロン") && invitePage.includes("予約の情報") && invitePage.includes("SalonPackのアカウントの作成やログインは不要"));
      check("スタッフ: 招待の値はアドレスバーから消える", !staffPage.url().includes("#"));

      await staffPage.getByRole("button", { name: "LINEで連携する" }).click();
      const linePage = await onSimulatedLine(staffPage, { account: "スタッフA(擬似LINE)", cancel: true });
      check("LINE ログイン: 友だち追加の案内(bot_prompt)付きで開く", linePage.includes("bot_prompt: aggressive"));
      check("LINE 連携のキャンセル: 理由と再試行の案内(招待は失効しない)", (await text(staffPage, "body")).includes("キャンセルされました"));
      await staffPage.getByRole("button", { name: "LINEで連携する" }).click();
      await onSimulatedLine(staffPage, { account: "スタッフA(擬似LINE)", addFriend: false });
      check("友だち未追加: 登録せず、友だち追加を案内して再試行できる", (await text(staffPage, "body")).includes("友だちに追加されていない"));
      await staffPage.getByRole("button", { name: "LINEで連携する" }).click();
      await onSimulatedLine(staffPage, { account: "スタッフA(擬似LINE)", addFriend: true });
      const done = await text(staffPage, "body");
      await shot(staffPage, "08-staff-registered");
      check("スタッフ: 登録完了は、サーバーの記録の店舗名で表示し、「通知開始」とは書かない", done.includes("ブラウザ確認サロン の予約通知の通知先に追加されました") && !done.includes("通知を開始"));
      check("スタッフ: トークの送信は不要と案内(旧サービスの応答を避ける)", done.includes("メッセージを送る必要はありません"));
      await staffPage.goto(`${BASE}/dashboard/notifications`);
      await staffPage.waitForURL(/\/login/, { timeout: 60_000 });
      check("スタッフは店舗の管理画面に入れない(ログイン画面になる)", staffPage.url().includes("/login"));

      await page.reload();
      await page.locator("[data-testid=recipient-row]", { hasText: "山田(スマホ)" }).waitFor({ timeout: 60_000 });
      const listed = await page.locator("[data-testid=recipient-row]", { hasText: "山田(スマホ)" }).innerText();
      check("オーナー: 通知先の一覧に反映(表示名・連携済み)", listed.includes("連携済み"));
      const { data: opsAfterAdd } = await admin.from("reservation_notification_operations").select("state").eq("salon_id", salonId).maybeSingle();
      check("通知先の追加では、予約通知は始まらない", !opsAfterAdd || opsAfterAdd.state === "setup_pending");
    }
    await page.locator("[data-testid=test-send-notice]").waitFor({ timeout: 60_000 });
    await checkSimulatedTestSend(page, admin, salonId, "PC");

    await page.getByRole("button", { name: "予約通知を開始する" }).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "予約通知を開始する" }).click();
    await page.getByText("稼働中").first().waitFor({ timeout: 60_000 });
    await shot(page, "09-active");
    const { data: opsActive } = await admin.from("reservation_notification_operations").select("state, activated_at, mail_fetch_since_reason").eq("salon_id", salonId).single();
    check("「予約通知を開始する」を押すと稼働中(取得開始は開始した日時)", opsActive?.state === "active" && opsActive.mail_fetch_since_reason === "customer_start");

    if (!invitesDisabled) {
      // 同じ LINE で2つ目の招待 → 「登録済み」(上書きしない・招待は使わない)。使わない招待は取消できる。
      const second = await createInvite(page, "2つ目の招待");
      await page.getByRole("button", { name: "閉じる" }).click();
      const staff2 = await browser.newContext(PHONE);
      staffContexts.push(staff2);
      const staffPage2 = await staff2.newPage();
      await staffPage2.goto(second);
      await staffPage2.getByRole("button", { name: "LINEで連携する" }).click();
      await onSimulatedLine(staffPage2, { account: "スタッフA(擬似LINE)" });
      check("同じ LINE での2つ目の招待: 「すでに登録されています」(重複して登録しない)", (await text(staffPage2, "body")).includes("すでに ブラウザ確認サロン の予約通知の通知先に登録されています"));
      await page.reload();
      check("通知先は1件のまま", (await page.locator("[data-testid=recipient-row]").count()) === 1);
      await page.locator("[data-testid=pending-invite]", { hasText: "2つ目の招待" }).getByRole("button", { name: "取消" }).click();
      await page.waitForLoadState("networkidle");
      await page.reload();
      check("使わない招待は取り消せる", (await page.locator("[data-testid=pending-invite]", { hasText: "2つ目の招待" }).count()) === 0);
      // 解除(確認のダイアログで承認)。
      await page.getByRole("button", { name: "通知先から解除" }).click();
      await page.waitForLoadState("networkidle");
      await page.reload();
      await shot(page, "10-removed");
      check("解除すると一覧から消え、予約通知の状態は「LINEの通知先がありません」", (await page.locator("[data-testid=recipient-row]").count()) === 0 && (await text(page)).includes("LINEの通知先がありません"));
    }
    for (const c of staffContexts) await c.close();

    // ---------------- Gmail だけの権限不足(定期処理が検知した状態)→ 権限を追加する ----------------
    await admin.rpc("google_mark_binding_scope", { p_salon_id: salonId, p_feature: "gmail", p_missing: true, p_granted_scopes: null });
    await page.goto(`${BASE}/dashboard/settings/google`);
    await page.getByText("Googleアカウント").first().waitFor({ timeout: 60_000 });
    const missing = await featureCardText(page, "予約通知");
    check("Gmail だけの権限不足: 予約通知のカードは「権限が不足しています」「権限を追加する」", missing.includes("権限が不足しています") && missing.includes("権限を追加する") && missing.includes("Gmailの権限が足りません"));
    if (reviewsEnabled) {
      const reviewsCard = await featureCardText(page, "届いた口コミ");
      check("同じアカウントの届いた口コミは巻き込まない(再接続を求めない)", reviewsCard.includes("許可済み") && !reviewsCard.includes("権限が不足") && !reviewsCard.includes("再接続"));
    }
    await page.getByRole("button", { name: "権限を追加する" }).click();
    await approveOnSimulatedGoogle(page, "owner@example.test");
    await page.getByText("Googleとの連携が完了しました").first().waitFor({ timeout: 60_000 });
    check("権限の追加のあと: 予約通知のカードは「許可済み」", (await featureCardText(page, "予約通知")).includes("許可済み"));
    const { data: opsAfter } = await admin.from("reservation_notification_operations").select("state, activated_at").eq("salon_id", salonId).single();
    check("権限の追加は運用状態を変えない(稼働中のまま・開始日時も同じ)", opsAfter?.state === "active" && opsAfter.activated_at === opsActive?.activated_at);
    await context.close();

    // ---------------- 旧サービス利用店舗: 内部の移行状態を見せない・引き継いだ設定は変更できない・追加しても稼働しない ----------------
    const legacy = await createTestSalon({ plan: "salonpack" });
    cleanups.push(legacy.cleanup);
    await admin.from("salon_feature_selections").upsert({ salon_id: legacy.salonId, feature_key: "reservation_notifications", selected: true }, { onConflict: "salon_id,feature_key" });
    await admin.from("salon_setup_state").upsert({ salon_id: legacy.salonId, feature_selection_saved_at: new Date().toISOString() }, { onConflict: "salon_id" });
    const legacyStaff = crypto.randomUUID();
    await admin.from("line_connections").insert({ id: legacyStaff, salon_id: legacy.salonId, destination_id: "U_browser_legacy", label: "引き継いだスタッフ", status: "connected", migrated_from_hmail_salon_id: legacyStaff });
    await admin.from("reservation_notification_operations").upsert({ salon_id: legacy.salonId, state: "awaiting_cutover", legacy_source: "hmail" }, { onConflict: "salon_id" });
    const legacyContext = await browser.newContext(PC);
    const legacyPage = await legacyContext.newPage();
    legacyPage.on("dialog", (dialog) => void dialog.accept());
    await login(legacyPage, legacy.email, legacy.password);
    await legacyPage.goto(`${BASE}/dashboard/settings/google`);
    await legacyPage.getByRole("button", { name: "Googleと連携する" }).first().click();
    await approveOnSimulatedGoogle(legacyPage, "staff@example.test");
    await legacyPage.getByText("Googleとの連携が完了しました").first().waitFor({ timeout: 60_000 });
    await shot(legacyPage, "11-legacy-connected");
    const legacyCard = await featureCardText(legacyPage, "予約通知");
    check("既存店舗の再接続後: 「Googleとの連携が完了しました。お客様の操作は以上です。LINEの再登録は不要です。」", legacyCard.includes("お客様の操作は以上です。LINEの再登録は不要です。") && legacyCard.includes("設定完了"));
    check("既存店舗: 内部の「切り替え待ち」は表示しない", !(await text(legacyPage)).includes("切り替え待ち"));
    await legacyPage.goto(`${BASE}/dashboard`);
    await legacyPage.waitForLoadState("networkidle");
    check("既存店舗: ホームで未完了の設定として繰り返し案内しない", !(await text(legacyPage)).includes("設定が必要な項目"));
    await legacyPage.goto(`${BASE}/dashboard/notifications`);
    await legacyPage.getByText("設定完了").first().waitFor({ timeout: 60_000 });
    await shot(legacyPage, "12-legacy-notifications");
    const legacyNotif = await text(legacyPage);
    check("既存店舗: 開始ボタンを出さず、「通知中」「切り替え待ち」と書かない", (await legacyPage.getByRole("button", { name: "予約通知を開始する" }).count()) === 0 && !legacyNotif.includes("通知中") && !legacyNotif.includes("切り替え待ち"));
    check("既存店舗: 接続済みの Google アカウントと LINE の通知先を確認できる", legacyNotif.includes("staff@example.test") && legacyNotif.includes("引き継いだスタッフ"));
    check("既存店舗: 全体スイッチは変更できず、理由と問い合わせの導線を出す", (await legacyPage.locator("#notif-master").isDisabled()) && legacyNotif.includes("設定の準備中のため変更できません"));
    const legacyRow = legacyPage.locator("[data-testid=recipient-row]", { hasText: "引き継いだスタッフ" });
    check("既存店舗: 引き継いだ通知先の ON/OFF は変更できず、解除のボタンも出さない", (await legacyRow.locator("input[type=checkbox]").first().isDisabled()) && (await legacyRow.getByRole("button", { name: "通知先から解除" }).count()) === 0);
    if (!invitesDisabled) {
      const legacyLink = await createInvite(legacyPage, "新しいスタッフ");
      await legacyPage.getByRole("button", { name: "閉じる" }).click();
      const staff3 = await browser.newContext(PHONE);
      const staffPage3 = await staff3.newPage();
      await staffPage3.goto(legacyLink);
      await waitText(staffPage3, "の予約通知の通知先に");
      check("既存店舗の招待ページにも、既存の通知先(引き継いだスタッフ)は表示しない", !(await text(staffPage3, "body")).includes("引き継いだスタッフ"));
      await staffPage3.getByRole("button", { name: "LINEで連携する" }).click();
      await onSimulatedLine(staffPage3, { account: "スタッフB(擬似LINE)" });
      const legacyDone = await text(staffPage3, "body");
      check("既存店舗に追加したスタッフ: 完了を「通知開始」と書かない", legacyDone.includes("通知先に追加されました") && !legacyDone.includes("通知を開始"));
      await staff3.close();
      await legacyPage.reload();
      const newRow = legacyPage.locator("[data-testid=recipient-row]", { hasText: "新しいスタッフ" });
      await newRow.waitFor({ timeout: 60_000 });
      check("既存店舗: 新しく追加した通知先は解除できる", (await newRow.getByRole("button", { name: "通知先から解除" }).count()) === 1);
      await newRow.getByRole("button", { name: "通知先から解除" }).click();
      await legacyPage.waitForLoadState("networkidle");
      await legacyPage.reload();
      check("既存店舗: 解除後も引き継いだ通知先は残る", (await legacyPage.locator("[data-testid=recipient-row]").count()) === 1);
    }
    const { data: legacyOps } = await admin.from("reservation_notification_operations").select("state, activated_at, mail_fetch_since").eq("salon_id", legacy.salonId).single();
    check("既存店舗: 再接続・招待・追加・解除のあとも運用状態は変わらない(稼働しない)", legacyOps?.state === "awaiting_cutover" && legacyOps.activated_at === null && legacyOps.mail_fetch_since === null);
    await legacyContext.close();

    // ---------------- 同じスマートフォンの別のタブで、別の店舗の招待を開いても取り違えない ----------------
    if (!invitesDisabled) await multiTabInvites(browser, admin, cleanups);
  } finally {
    await browser.close().catch(() => {});
    for (const c of cleanups) await c().catch(() => {});
    const { data } = await admin.from("google_accounts").select("id").in("google_sub", ["100000000000000000001", "100000000000000000002"]);
    const ids = (data ?? []).map((r) => r.id as string);
    if (ids.length > 0) {
      await admin.from("salon_google_bindings").delete().in("google_account_id", ids);
      await admin.from("google_accounts").delete().in("id", ids);
    }
    if (process.platform === "win32" && server.pid) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { shell: true });
    else server.kill("SIGTERM");
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 件 OK`);
    setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 2000);
  })
  .catch((error) => {
    console.error("止めました:", error instanceof Error ? error.message : String(error));
    setTimeout(() => process.exit(1), 2000);
  });
