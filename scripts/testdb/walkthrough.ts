/**
 * 画面の通し確認(テスト用DB + 擬似 Google)。開発サーバーをテスト用DBの設定で起動し、テスト用の店舗の
 * オーナーとしてログインした状態で、実際の画面(サーバーで描画した HTML)と、Google 連携の
 * リダイレクトの往復(擬似 Google の同意画面 → コールバック)を HTTP でたどって確かめる。
 * 本物の Google・LINE には接続しない。共有・本番の DB には接続しない(scripts/testdb/target.mjs で確認)。
 *
 *   npx tsx scripts/testdb/walkthrough.ts [--reviews-enabled]
 */
import { spawn, type ChildProcess } from "child_process";
import { createServerClient } from "@supabase/ssr";
import { buildChildEnv, loadTestTarget } from "./target.mjs";

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const reviewsEnabled = process.argv.includes("--reviews-enabled");

const target = loadTestTarget({ requireDatabaseUrl: true });
const childEnv = buildChildEnv(target, process.env, PORT) as Record<string, string>;
if (reviewsEnabled) childEnv.GOOGLE_REVIEWS_OAUTH_ENABLED = "1";
// .env.local の NEXT_PUBLIC_APP_MODE(口コミ専用の設定)ではなく、SalonPack のデプロイとして確かめる。
childEnv.NEXT_PUBLIC_APP_MODE = process.argv.includes("--reviews-mode") ? "reviews" : "salonpack";
for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;

const results: Array<{ ok: boolean; label: string }> = [];
function check(label: string, ok: boolean) {
  results.push({ ok, label });
  console.log(`${ok ? "✓" : "✗"} ${label}`);
}

function startServer(): ChildProcess {
  const child: ChildProcess = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: childEnv as NodeJS.ProcessEnv,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("開発サーバーが起動しませんでした");
}

async function loginCookie(email: string, password: string): Promise<string> {
  const jar: Array<{ name: string; value: string }> = [];
  const client = createServerClient(childEnv.NEXT_PUBLIC_SUPABASE_URL, childEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cookies) => {
        for (const c of cookies) {
          const i = jar.findIndex((x) => x.name === c.name);
          if (i >= 0) jar.splice(i, 1);
          if (c.value) jar.push({ name: c.name, value: c.value });
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログインできません: ${error.message}`);
  return jar.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function page(path: string, cookie: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "follow" });
  const html = await res.text();
  if (process.env.WALKTHROUGH_DUMP_DIR) {
    const { writeFileSync } = await import("fs");
    writeFileSync(`${process.env.WALKTHROUGH_DUMP_DIR}/${path.replace(/[^a-z0-9]+/gi, "_")}.html`, `<!-- ${res.status} ${res.url} -->\n${html}`);
  }
  return html;
}

/** 擬似 Google の同意画面で「許可する」を押し、コールバックをたどって最終的な URL を返す。 */
async function approveGoogle(
  authorizationUrl: string,
  cookie: string,
  options: { cookieAtCallback?: string; grant?: string[]; sub?: string } = {}
) {
  const consent = await fetch(authorizationUrl);
  const html = await consent.text();
  const promptShown = /prompt: \(なし\)/.test(html);
  const url = new URL(authorizationUrl);
  const form = new URLSearchParams();
  for (const k of ["state", "nonce", "code_challenge", "redirect_uri", "scope", "include_granted_scopes", "prompt", "client_id"]) {
    form.set(k, url.searchParams.get(k) ?? "");
  }
  form.set("sub", options.sub ?? "100000000000000000001");
  for (const g of options.grant ?? (url.searchParams.get("scope") ?? "").split(" ").filter((s) => s.startsWith("https://"))) form.append("grant", g);
  form.set("decision", "allow");
  const approved = await fetch(`${BASE}/api/google/oauth/simulated-authorize`, { method: "POST", body: form, redirect: "manual" });
  const callback = approved.headers.get("location")!;
  const done = await fetch(callback, { headers: { cookie: options.cookieAtCallback ?? cookie }, redirect: "manual" });
  return { consentHtml: html, noPrompt: promptShown, location: done.headers.get("location") ?? "" };
}

async function main() {
const { createTestSalon, notificationsTestAdminClient } = await import("./notificationsFixtures");
const { startGoogleConnect } = await import("@/lib/google/oauthFlow");
const { getGoogleFlowDeps } = await import("@/lib/google/runtime");
const server = startServer();
const admin = notificationsTestAdminClient();
const cleanups: Array<() => Promise<void>> = [];
try {
  await waitForServer();
  console.log(`開発サーバー起動(テスト用DB・擬似Google・届いた口コミ ${reviewsEnabled ? "有効" : "準備中"})`);

  // ---- 新規の店舗(契約: salonpack): ホームに全機能を並べ、未設定の機能は「設定が必要」----
  const salon = await createTestSalon({ plan: "salonpack" });
  cleanups.push(salon.cleanup);
  const cookie = await loginCookie(salon.email, salon.password);

  const home1 = await page("/dashboard", cookie);
  check(
    "初回: ホームに全機能を並べる(機能を選ぶ画面は出さない)",
    !home1.includes("使う機能を選びましょう") && ["口コミ", "ブログ", "予約通知"].every((label) => home1.includes(label))
  );
  check("届いた口コミは、受信箱などの中身と一緒に入れるまでホームに出さない(提供フラグに関係なく)", !home1.includes("届いた口コミ"));
  check("未設定の機能は「設定が必要」から設定へ進める(予約通知は Google 連携へ)", home1.includes("設定が必要") && home1.includes("設定へ進む") && home1.includes("Googleと連携(予約メール)"));
  const { data: opsAfterHome } = await admin.from("reservation_notification_operations").select("state").eq("salon_id", salon.salonId).maybeSingle();
  const { data: switchAfterHome } = await admin.from("salon_feature_selections").select("selected").eq("salon_id", salon.salonId);
  check("ホームを表示しただけでは、予約通知の運用状態・内部スイッチを作らない", !opsAfterHome && (switchAfterHome ?? []).length === 0);

  // 旧サービス利用店舗として、切り替え待ちにしておく(運営の静的移行に相当。運営の移行は予約通知の行を ON で作る)。
  await admin.from("salon_feature_selections").insert({ salon_id: salon.salonId, feature_key: "reservation_notifications", selected: true });
  await admin.from("reservation_notification_operations").insert({ salon_id: salon.salonId });
  await admin.from("line_connections").insert({ id: crypto.randomUUID(), salon_id: salon.salonId, destination_id: "U_walk_staff", status: "connected", migrated_from_hmail_salon_id: "walk-legacy" });
  await admin.from("reservation_notification_operations").update({ state: "awaiting_cutover", legacy_source: "hmail" }).eq("salon_id", salon.salonId);

  const google1 = await page("/dashboard/settings/google", cookie);
  check("Google連携の画面: 予約通知に「Googleと連携する」、届いた口コミのカードは出さない", google1.includes("Googleと連携する") && !google1.includes("届いた口コミ"));

  // ---- Google 連携(擬似 Google の同意画面 → コールバック)----
  const deps = getGoogleFlowDeps();
  const features = reviewsEnabled ? (["gmail", "gbp"] as const) : (["gmail"] as const);
  const startUrl = await startGoogleConnect({ salonId: salon.salonId, userId: salon.userId, features: [...features], purpose: "connect" }, deps);
  const first = await approveGoogle(startUrl, cookie);
  check("同意画面は prompt なし(通常の接続で同意を強制しない)", first.noPrompt);
  check("コールバック → Google連携の画面へ「連携完了」", first.location.includes("/dashboard/settings/google?google=connected"));

  const google2 = await page("/dashboard/settings/google?google=connected", cookie);
  check("連携後: アカウントと権限を機能ごとに表示", google2.includes("Googleとの連携が完了しました") && google2.includes("owner@example.test") && google2.includes("許可済み"));
  check("通常利用では接続ボタンを出さない", !google2.includes("Googleと連携する</button>") && !google2.includes(">Googleと連携する<"));
  check("届いた口コミは、連携のあとも Google連携の画面に出さない", !google2.includes("届いた口コミ"));

  const notifications = await page("/dashboard/notifications", cookie);
  check(
    "既存店舗の再接続後: 「お客様の操作は以上です」を表示し、内部の「切り替え待ち」は見せない(同意と通知開始を混同させない)",
    notifications.includes("お客様の操作は以上です。LINEの再登録は不要です。") && !notifications.includes("切り替え待ち") && !notifications.includes("通知中")
  );
  check("切り替え待ちの店舗には開始ボタンを出さない", !notifications.includes("予約通知を開始する"));
  const { data: opsRow } = await admin.from("reservation_notification_operations").select("state, activated_at").eq("salon_id", salon.salonId).single();
  check("Google 連携の前後で運用状態は切り替え待ちのまま", opsRow?.state === "awaiting_cutover" && opsRow.activated_at === null);

  // ---- 再接続(同じアカウント): 同意画面を強制しない・運用状態は変わらない ----
  const again = await startGoogleConnect({ salonId: salon.salonId, userId: salon.userId, features: ["gmail"], purpose: "connect" }, deps);
  const second = await approveGoogle(again, cookie);
  check("再接続も prompt なし・連携完了", second.noPrompt && second.location.includes("google=connected"));

  // ---- 途中でログアウト: コールバックでセッションが無ければ何も保存しない ----
  const third = await startGoogleConnect({ salonId: salon.salonId, userId: salon.userId, features: ["gmail"], purpose: "connect" }, deps);
  const loggedOut = await approveGoogle(third, cookie, { cookieAtCallback: "" });
  check("途中でログアウトしたらログイン画面へ(保存しない)", loggedOut.location.includes("/login"));

  // ---- 旧サービスを使っていない店舗: 条件がそろうと「開始待ち」(自動では始まらない)----
  const fresh = await createTestSalon({ plan: "salonpack" });
  cleanups.push(fresh.cleanup);
  const freshCookie = await loginCookie(fresh.email, fresh.password);
  await admin.from("line_connections").insert({ salon_id: fresh.salonId, destination_id: "U_walk_new", status: "connected" });
  // 同じ受信箱(1つ目の店舗の Gmail)は別の店舗の予約通知には使えない。
  const sameInbox = await startGoogleConnect({ salonId: fresh.salonId, userId: fresh.userId, features: ["gmail"], purpose: "connect" }, deps);
  const sameInboxResult = await approveGoogle(sameInbox, freshCookie);
  check("別の店舗が使っている受信箱では連携しない", sameInboxResult.location.includes("google=gmail_account_in_use"));
  const freshStart = await startGoogleConnect({ salonId: fresh.salonId, userId: fresh.userId, features: ["gmail"], purpose: "connect" }, deps);
  const freshResult = await approveGoogle(freshStart, freshCookie, { sub: "100000000000000000002" });
  check("新規店舗は自分の受信箱で連携できる", freshResult.location.includes("google=connected"));
  const freshNotifications = await page("/dashboard/notifications", freshCookie);
  check("新規店舗: 連携できても通知は自動では始まらず「開始待ち」(開始ボタンあり)", freshNotifications.includes("まだ始まっていません") && freshNotifications.includes("予約通知を開始する"));
} finally {
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
