// 共通の Google 連携(認証情報・店舗ごとの結び付け・state・取り消し)の testdb テスト。
// 隔離したテスト用 Supabase(実 Postgres、複数接続)と擬似 Google で検証する(本物の Google には接続しない)。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { setupNotificationsTestEnv, openDirectConnections, closeConnections } from "./setupNotificationsEnv";
import { browserClient, createTestSalon, notificationsTestAdminClient, type TestSalonFixture } from "./notificationsFixtures";
import { connectGoogle, createGoogleTestDeps, uniqueSub } from "./googleFixtures";

const target = setupNotificationsTestEnv();
const admin = notificationsTestAdminClient();
const { GOOGLE_SCOPES } = await import("@/lib/google/scopes");
const { listSalonGoogleBindings } = await import("@/lib/google/db/bindings");
const { processGoogleRevocations } = await import("@/lib/google/revocations");
const { startGoogleConnect, completeGoogleConnect } = await import("@/lib/google/oauthFlow");
const { sha256Hex } = await import("@/lib/google/randomness");

const SUB_A = "200000000000000000001";
const SUB_B = "200000000000000000002";
const SUB_REVIEWS = "200000000000000000003";

let conns: postgres.Sql[] = [];
const salons: TestSalonFixture[] = [];

async function cleanupAccounts() {
  const { data } = await admin.from("google_accounts").select("id").in("google_sub", [SUB_A, SUB_B, SUB_REVIEWS]);
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length === 0) return;
  await admin.from("salon_google_bindings").delete().in("google_account_id", ids);
  await admin.from("google_accounts").delete().in("id", ids);
}

async function newSalon() {
  const salon = await createTestSalon();
  salons.push(salon);
  return salon;
}

async function opsOf(salonId: string) {
  const { data } = await admin.from("reservation_notification_operations").select("state, mail_fetch_since, activated_at").eq("salon_id", salonId).maybeSingle();
  return data;
}

beforeAll(async () => {
  conns = await openDirectConnections(target, 2);
  await cleanupAccounts();
});
afterAll(async () => {
  for (const s of salons) await s.cleanup();
  await cleanupAccounts();
  await closeConnections(conns);
});

describe("ブラウザからのアクセス拒否(RLS・権限の取り消し)", () => {
  it("anon と、ログインしたお客様のどちらでも、認証情報・state・取り消し・運用状態の表と関数に触れない", async () => {
    const salon = await newSalon();
    const anon = await browserClient();
    const user = await browserClient({ email: salon.email, password: salon.password });
    const tables = [
      "google_accounts",
      "salon_google_bindings",
      "google_oauth_states",
      "google_revocations",
      "salon_google_connection_events",
      "salon_feature_selections",
      "salon_setup_state",
      "reservation_notification_operations",
      "reservation_stop_intervals",
      "legacy_reconciliation_runs",
      "legacy_cutover_snapshots",
      "gmail_scan_state",
      "notification_deliveries",
      "salon_plan_changes",
    ];
    for (const client of [anon, user]) {
      for (const table of tables) {
        const { data, error } = await client.from(table).select("*").limit(1);
        expect(error ?? (data && data.length === 0 ? "empty" : null), table).toBeTruthy();
        const { error: insertError } = await client.from(table).insert({});
        expect(insertError, `${table} insert`).toBeTruthy();
      }
      for (const fn of ["google_consume_oauth_state", "google_bind_features", "reservation_ops_customer_start", "notifications_claim_delivery_v2", "reservation_ops_activate"]) {
        const { error } = await client.rpc(fn, {});
        expect(error, fn).toBeTruthy();
      }
    }
    // ログインしたお客様が自分の店舗の契約を変えることもできない(0011)。
    const reviewsSalon = await createTestSalon({ plan: "reviews" });
    salons.push(reviewsSalon);
    const owner = await browserClient({ email: reviewsSalon.email, password: reviewsSalon.password });
    const { error: planError } = await owner.from("salons").update({ plan: "salonpack" }).eq("id", reviewsSalon.salonId);
    expect(planError).toBeTruthy();
    const { data: salonRow } = await admin.from("salons").select("plan").eq("id", reviewsSalon.salonId).single();
    expect(salonRow!.plan).toBe("reviews");
  });
});

describe("OAuth の state: 開始したユーザー・店舗に結び付き、期限付き・1回限り", () => {
  let salon: TestSalonFixture;
  beforeAll(async () => (salon = await newSalon()));

  it("同じ state を2つの接続から同時に消費しても、1回だけ成功する", async () => {
    const { deps } = createGoogleTestDeps();
    const url = await startGoogleConnect({ salonId: salon.salonId, userId: salon.userId, features: ["gmail"], purpose: "connect" }, deps);
    const hash = sha256Hex(new URL(url).searchParams.get("state")!);
    const [a, b] = await Promise.all([
      conns[0]`select * from google_consume_oauth_state(${hash}, ${salon.salonId}::uuid, ${salon.userId}::uuid)`,
      conns[1]`select * from google_consume_oauth_state(${hash}, ${salon.salonId}::uuid, ${salon.userId}::uuid)`,
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it("途中でログアウトして別のユーザー・別の店舗で戻ってきたら拒否し、何も保存しない", async () => {
    const other = await newSalon();
    const { sim, deps } = createGoogleTestDeps();
    const { result } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: SUB_A, callbackAs: { salonId: other.salonId, userId: other.userId } });
    expect(result).toMatchObject({ status: "failed", reason: "state_invalid" });
    expect(await listSalonGoogleBindings(salon.salonId)).toHaveLength(0);
    expect(await listSalonGoogleBindings(other.salonId)).toHaveLength(0);
  });

  it("期限切れの state は拒否する", async () => {
    const { sim, deps } = createGoogleTestDeps();
    const url = await startGoogleConnect({ salonId: salon.salonId, userId: salon.userId, features: ["gmail"], purpose: "connect" }, deps);
    const { code, state } = sim.approve(url, { sub: SUB_A });
    await admin.from("google_oauth_states").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("state_hash", sha256Hex(state));
    const result = await completeGoogleConnect({ salonId: salon.salonId, userId: salon.userId, stateParam: state, code, oauthError: null }, deps);
    expect(result).toMatchObject({ status: "failed", reason: "state_invalid" });
  });
});

describe("接続・再接続・権限の追加で、予約通知の運用状態を変えない", () => {
  let salon: TestSalonFixture;
  const { sim, deps } = createGoogleTestDeps();
  beforeAll(async () => {
    salon = await newSalon();
    await admin.from("reservation_notification_operations").insert({ salon_id: salon.salonId, state: "awaiting_cutover", legacy_source: "hmail" });
  });

  it("切り替え待ちの店舗が Gmail を接続しても切り替え待ちのまま(メール取得開始・開始日時も入らない)", async () => {
    const { result } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: SUB_A });
    expect(result).toMatchObject({ status: "connected", missing: [] });
    expect(await opsOf(salon.salonId)).toMatchObject({ state: "awaiting_cutover", mail_fetch_since: null, activated_at: null });
    const [binding] = await listSalonGoogleBindings(salon.salonId);
    expect(binding).toMatchObject({ feature: "gmail", accountEmail: "owner-a@example.test" });
    expect(binding.lastReconnectedAt).toBeNull();
  });

  it("再接続(Google は新しい refresh token を返さない)でも同意画面を強制せず、保存済みの認証情報を確かめて使う。運用状態は変えない", async () => {
    const { result, url } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: SUB_A });
    expect(result.status).toBe("connected");
    expect(new URL(url).searchParams.get("prompt")).toBeNull();
    const [binding] = await listSalonGoogleBindings(salon.salonId);
    expect(binding.lastReconnectedAt).not.toBeNull();
    expect(await opsOf(salon.salonId)).toMatchObject({ state: "awaiting_cutover", activated_at: null });
    const { data: events } = await admin.from("salon_google_connection_events").select("event").eq("salon_id", salon.salonId).order("occurred_at");
    expect(events!.map((e) => e.event)).toEqual(["connected", "reconnected"]);
  });

  it("届いた口コミの権限を後から追加しても、予約メールの結び付け・運用状態は変わらない", async () => {
    const before = (await listSalonGoogleBindings(salon.salonId)).find((b) => b.feature === "gmail")!;
    const { result } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gbp"], sub: SUB_A, purpose: "add_scope", expectedGoogleSub: SUB_A });
    expect(result).toMatchObject({ status: "connected" });
    const after = await listSalonGoogleBindings(salon.salonId);
    const gmail = after.find((b) => b.feature === "gmail")!;
    expect(gmail.googleAccountId).toBe(before.googleAccountId);
    expect(gmail.accountBoundAt).toBe(before.accountBoundAt);
    expect(after.find((b) => b.feature === "gbp")).toMatchObject({ gbpSelectionState: "selection_pending" });
    expect(gmail.account.grantedScopes).toEqual(expect.arrayContaining([GOOGLE_SCOPES.gmail, GOOGLE_SCOPES.gbp]));
    expect(await opsOf(salon.salonId)).toMatchObject({ state: "awaiting_cutover" });
  });

  it("再認証で、開始時と違うアカウントを選んだら拒否する", async () => {
    const { result } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: SUB_B, purpose: "reauth", expectedGoogleSub: SUB_A });
    expect(result).toMatchObject({ status: "failed", reason: "account_mismatch" });
    expect((await listSalonGoogleBindings(salon.salonId)).find((b) => b.feature === "gmail")!.account.googleSub).toBe(SUB_A);
  });
});

describe("片方だけ許可・許可が不明・同一/別アカウント", () => {
  const { sim, deps } = createGoogleTestDeps();

  beforeEach(() => {
    // 各ケースの擬似 Google の許可を独立させる(同じアカウントの過去の許可を引き継がない)。
  });

  it("両方を要求して Gmail だけ許可された → 予約メールだけ接続済み、口コミは権限不足として記録", async () => {
    const salon = await newSalon();
    const { result } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail", "gbp"], sub: SUB_B, grantScopes: [GOOGLE_SCOPES.gmail] });
    expect(result).toMatchObject({ status: "connected", missing: ["gbp"] });
    expect((await listSalonGoogleBindings(salon.salonId)).map((b) => b.feature)).toEqual(["gmail"]);
    const { data: events } = await admin.from("salon_google_connection_events").select("feature, event").eq("salon_id", salon.salonId);
    expect(events).toEqual(expect.arrayContaining([{ feature: "gbp", event: "scope_missing" }]));
  });

  it("応答に許可された権限が無い(不明)なら、要求した権限があるとは推測せず、何も接続しない", async () => {
    const salon = await newSalon();
    const fresh = createGoogleTestDeps();
    fresh.sim.omitScopeOnNextResponse();
    const { result } = await connectGoogle({ sim: fresh.sim, deps: fresh.deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: SUB_REVIEWS });
    expect(result).toMatchObject({ status: "failed", reason: "no_scope_granted" });
    expect(await listSalonGoogleBindings(salon.salonId)).toHaveLength(0);
  });

  it("同じアカウントの Gmail を別の店舗の予約メールには使えない(別店舗のお客様の予約が届かないように)。口コミは共有できる", async () => {
    const first = await newSalon();
    const second = await newSalon();
    const shared = createGoogleTestDeps();
    expect((await connectGoogle({ sim: shared.sim, deps: shared.deps, salonId: first.salonId, userId: first.userId, features: ["gmail"], sub: SUB_REVIEWS })).result.status).toBe("connected");
    const denied = await connectGoogle({ sim: shared.sim, deps: shared.deps, salonId: second.salonId, userId: second.userId, features: ["gmail"], sub: SUB_REVIEWS });
    expect(denied.result).toMatchObject({ status: "failed", reason: "gmail_account_in_use" });
    const ok = await connectGoogle({ sim: shared.sim, deps: shared.deps, salonId: second.salonId, userId: second.userId, features: ["gbp"], sub: SUB_REVIEWS });
    expect(ok.result.status).toBe("connected");
    // 認証情報は Google アカウントごとに1つ(店舗ごとに複製しない)。
    const { data: accounts } = await admin.from("google_accounts").select("id").eq("google_sub", SUB_REVIEWS);
    expect(accounts).toHaveLength(1);
  });
});

describe("利用停止と、Google 連携の解除・取り消しを区別する", () => {
  const extraSubs: string[] = [];
  function freshAccount() {
    const sub = uniqueSub();
    extraSubs.push(sub);
    return { sub, ...createGoogleTestDeps({ extraUsers: [{ sub, email: `${sub}@example.test` }] }) };
  }
  afterAll(async () => {
    const { data } = await admin.from("google_accounts").select("id").in("google_sub", extraSubs);
    const ids = (data ?? []).map((r) => r.id as string);
    if (ids.length > 0) {
      await admin.from("salon_google_bindings").delete().in("google_account_id", ids);
      await admin.from("google_accounts").delete().in("id", ids);
    }
  });

  it("口コミの利用停止で予約メールは切れない。全解除しても、他の店舗が使っているアカウントは取り消さない。最後の参照が外れたときだけ取り消す", async () => {
    const { sim, deps, sub } = freshAccount();
    const salonA = await newSalon();
    const salonB = await newSalon();
    expect((await connectGoogle({ sim, deps, salonId: salonA.salonId, userId: salonA.userId, features: ["gmail", "gbp"], sub })).result.status).toBe("connected");
    expect((await connectGoogle({ sim, deps, salonId: salonB.salonId, userId: salonB.userId, features: ["gbp"], sub })).result.status).toBe("connected");
    const { unbindGoogleFeatures } = await import("@/lib/google/db/bindings");

    await unbindGoogleFeatures({ salonId: salonA.salonId, features: ["gbp"], userId: salonA.userId, revokeIfUnreferenced: false });
    expect((await listSalonGoogleBindings(salonA.salonId)).map((b) => b.feature)).toEqual(["gmail"]);

    const resultA = await unbindGoogleFeatures({ salonId: salonA.salonId, features: ["gmail", "gbp"], userId: salonA.userId, revokeIfUnreferenced: true });
    expect(resultA).toEqual([expect.objectContaining({ remainingReferences: 1, revocationEnqueued: false })]);
    await processGoogleRevocations({ transport: sim.transport });
    expect(sim.revokedSubs()).toEqual([]);

    const resultB = await unbindGoogleFeatures({ salonId: salonB.salonId, features: ["gmail", "gbp"], userId: salonB.userId, revokeIfUnreferenced: true });
    expect(resultB).toEqual([expect.objectContaining({ remainingReferences: 0, revocationEnqueued: true })]);
    expect(await processGoogleRevocations({ transport: sim.transport })).toEqual({ revoked: 1, failed: 0 });
    expect(sim.revokedSubs()).toEqual([sub]);
  });

  it("全解除のあと、取り消しの実行前に再接続したら、古い取り消しジョブは新しい認可を取り消さない", async () => {
    const { sim, deps, sub } = freshAccount();
    const salon = await newSalon();
    expect((await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub })).result.status).toBe("connected");
    const { unbindGoogleFeatures } = await import("@/lib/google/db/bindings");
    await unbindGoogleFeatures({ salonId: salon.salonId, features: ["gmail"], userId: salon.userId, revokeIfUnreferenced: true });
    // 取り消しを処理する前に再接続(新しい同意 → 新しい refresh token)。
    const { result } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub });
    expect(result.status).toBe("connected");
    expect(await processGoogleRevocations({ transport: sim.transport })).toEqual({ revoked: 0, failed: 0 });
    expect(sim.revokedSubs()).toEqual([]);
    const { data: jobs } = await admin.from("google_revocations").select("cancelled_at, done_at").order("enqueued_at", { ascending: false }).limit(1);
    expect(jobs![0].cancelled_at).not.toBeNull();
  });

  it("取り消しの実行中(リース中)に戻ってきた再接続は保存せず、時間をおいて再試行してもらう", async () => {
    const { sim, deps, sub } = freshAccount();
    const salon = await newSalon();
    expect((await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub })).result.status).toBe("connected");
    const { unbindGoogleFeatures } = await import("@/lib/google/db/bindings");
    await unbindGoogleFeatures({ salonId: salon.salonId, features: ["gmail"], userId: salon.userId, revokeIfUnreferenced: true });
    const [job] = await conns[0]`select * from google_begin_revocation()`;
    expect(job).toBeTruthy();
    const { result } = await connectGoogle({ sim, deps, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub });
    expect(result).toMatchObject({ status: "failed", reason: "revocation_in_progress" });
    await conns[0]`select google_finish_revocation(${job.id}::uuid, true, null)`;
  });
});
