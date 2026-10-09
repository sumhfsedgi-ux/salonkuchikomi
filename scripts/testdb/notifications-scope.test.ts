// Gmail だけの権限不足と、Google アカウント全体の認証失敗を分けて扱うことの testdb テスト。
// 同じ Google アカウントで予約メール(Gmail)と届いた口コミ(GBP)を連携した店舗で確かめる。
// Google は擬似、Gmail・LINE はモック(本物の Google・LINE には接続しない)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupNotificationsTestEnv } from "./setupNotificationsEnv";
import { createTestLineConnection, createTestSalon, notificationsTestAdminClient, type TestSalonFixture } from "./notificationsFixtures";
import { connectGoogle, createGoogleTestDeps, uniqueSub } from "./googleFixtures";
import { inbox, providersBySalon, reservationMail, type TestInbox, type TestMail } from "./mailboxFixtures";

setupNotificationsTestEnv();
process.env.NEXT_PUBLIC_APP_MODE = "salonpack";
process.env.GOOGLE_REVIEWS_OAUTH_ENABLED = "1";
const admin = notificationsTestAdminClient();
const { pollMailForAllSalons } = await import("@/lib/notifications/jobs/pollMailForAllSalons");
const { customerStartReservationNotifications } = await import("@/lib/notifications/db/operations");
const { MailProviderError } = await import("@/lib/notifications/mail/MailProvider");
const { GOOGLE_SCOPES } = await import("@/lib/google/scopes");
const { loadSetupContext } = await import("@/lib/features/setupContext");
const { resolveFeatureStates } = await import("@/lib/features/featureState");

const sub = uniqueSub();
const google = createGoogleTestDeps({ reviewsEnabled: true, extraUsers: [{ sub, email: "scope-shop@example.test" }] });
let salon: TestSalonFixture;
let accountId: string;
const mails: Record<string, TestMail> = {};
const boxes = new Map<string, TestInbox>();
const sends: Array<{ destination: string; text: string }> = [];
let failList: InstanceType<typeof MailProviderError> | null = null;

const tick = () =>
  pollMailForAllSalons({
    transport: google.sim.transport,
    config: google.deps.config,
    sendLine: async (destination, text) => {
      sends.push({ destination, text });
      return { outcome: "sent", requestId: `r-${sends.length}` };
    },
    createProvider: providersBySalon(boxes),
  });

async function account() {
  const { data } = await admin.from("google_accounts").select("auth_state, consecutive_auth_failures").eq("id", accountId).single();
  return data!;
}

async function bindings() {
  const { data } = await admin.from("salon_google_bindings").select("feature, scope_missing_since").eq("salon_id", salon.salonId);
  return new Map((data ?? []).map((b) => [b.feature as string, b.scope_missing_since as string | null]));
}

async function openStops() {
  const { data } = await admin.from("reservation_stop_intervals").select("kind").eq("salon_id", salon.salonId).is("ended_at", null);
  return (data ?? []).map((r) => r.kind as string).sort();
}

async function featureStatuses() {
  const ctx = await loadSetupContext({ id: salon.salonId, plan: "salonpack", onboardingCompleted: false, googleReviewUrl: null });
  const { states } = resolveFeatureStates(ctx);
  const of = (key: string) => states.find((s) => s.key === key)!;
  return { reservation: of("reservation_notifications"), reviews: of("google_reviews") };
}

beforeAll(async () => {
  salon = await createTestSalon();
  await createTestLineConnection(salon.salonId, { label: "スタッフ" });
  await admin.from("salon_feature_selections").upsert(
    [
      { salon_id: salon.salonId, feature_key: "reservation_notifications", selected: true },
      { salon_id: salon.salonId, feature_key: "google_reviews", selected: true },
    ],
    { onConflict: "salon_id,feature_key" }
  );
  await admin.from("salon_setup_state").upsert({ salon_id: salon.salonId, feature_selection_saved_at: new Date().toISOString() }, { onConflict: "salon_id" });
  // 同じアカウントで、予約メールと口コミをまとめて連携。
  const { result } = await connectGoogle({ ...google, salonId: salon.salonId, userId: salon.userId, features: ["gmail", "gbp"], sub });
  expect(result.status).toBe("connected");
  const { data } = await admin.from("google_accounts").select("id").eq("google_sub", sub).single();
  accountId = data!.id as string;
  expect(await customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: ["salonpack"] })).toBe("started");
  boxes.set(salon.salonId, inbox(mails, { failWith: (op) => (op === "list" ? failList : null) }));
});

afterAll(async () => {
  await salon.cleanup();
  await admin.from("salon_google_bindings").delete().eq("google_account_id", accountId);
  await admin.from("google_accounts").delete().eq("id", accountId);
});

describe("Gmail だけの権限不足は、アカウント全体の認証失敗として数えない", () => {
  it("Gmail の API が insufficient_scope を何度返しても、アカウントは有効のまま・口コミ(GBP)の結び付けもそのまま", async () => {
    failList = new MailProviderError("insufficient_scope");
    await tick();
    await tick();
    await tick();
    expect(await account()).toEqual({ auth_state: "active", consecutive_auth_failures: 0 });
    const b = await bindings();
    expect(b.get("gmail")).toBeTruthy();
    expect(b.get("gbp")).toBeNull();
    expect(await openStops()).toEqual(["gmail_scope"]); // 認証切れ(auth)の停止期間は開かない
    const { data: events } = await admin.from("salon_google_connection_events").select("feature, event").eq("salon_id", salon.salonId).eq("event", "scope_missing");
    expect(events).toEqual([{ feature: "gmail", event: "scope_missing" }]); // 状態が変わったときの1回だけ
    expect(sends.filter((s) => s.text.includes("Gmailの読み取り"))).toHaveLength(1); // お客様への連絡も1回だけ

    const { reservation, reviews } = await featureStatuses();
    expect(reservation.status).toBe("reconnect_required");
    expect(reservation.message).toContain("Gmailの権限が足りません");
    expect(reviews.status).not.toBe("reconnect_required");
  });

  it("Gmail を読めるようになったら、権限不足の記録を消して停止期間を閉じる。止まっていた間の予約(24時間以内)は届く", async () => {
    failList = null;
    const before = sends.length;
    mails.s1 = reservationMail(new Date(), "s1");
    await tick();
    const b = await bindings();
    expect(b.get("gmail")).toBeNull();
    expect(await openStops()).toEqual([]);
    const { data: restored } = await admin.from("salon_google_connection_events").select("event").eq("salon_id", salon.salonId).eq("event", "scope_restored");
    expect(restored).toHaveLength(1);
    expect(sends.length).toBe(before + 1);
    expect((await featureStatuses()).reservation.status).toBe("active");
  });

  it("トークンの更新の応答で Gmail の権限が外れていると分かった場合も、予約メールだけを止める(Gmail は読まない。アカウントの失敗回数は増やさない)", async () => {
    // 利用者が Google 側で口コミの権限だけを許可し直した(Gmail の権限が外れた)。
    google.sim.authorize({
      sub,
      requestedScopes: ["openid", "email", GOOGLE_SCOPES.gbp],
      grantScopes: [GOOGLE_SCOPES.gbp],
      includeGrantedScopes: false,
      nonce: "n",
      codeChallenge: "c",
      redirectUri: "http://localhost/unused",
    });
    const box = boxes.get(salon.salonId)!;
    const listsBefore = box.calls.filter((c) => c.op === "list").length;
    await tick();
    await tick();
    expect(box.calls.filter((c) => c.op === "list").length).toBe(listsBefore);
    expect(await account()).toEqual({ auth_state: "active", consecutive_auth_failures: 0 });
    const b = await bindings();
    expect(b.get("gmail")).toBeTruthy();
    expect(b.get("gbp")).toBeNull();
    expect((await featureStatuses()).reviews.status).not.toBe("reconnect_required");
  });

  it("認可そのものの失効(トークンの更新で invalid_grant)は共通の再認証: 2回続くと、予約メールと口コミの両方が再接続が必要", async () => {
    google.sim.failNextRefresh("invalid_grant");
    await tick();
    expect((await account()).auth_state).toBe("active"); // 1回だけでは再接続を求めない
    google.sim.failNextRefresh("invalid_grant");
    await tick();
    expect(await account()).toMatchObject({ auth_state: "needs_reauth", consecutive_auth_failures: 2 });
    const { data: events } = await admin.from("salon_google_connection_events").select("feature").eq("salon_id", salon.salonId).eq("event", "needs_reauth");
    expect((events ?? []).map((e) => e.feature).sort()).toEqual(["gbp", "gmail"]);
    expect(await openStops()).toContain("auth");
    const { reservation, reviews } = await featureStatuses();
    expect(reservation.status).toBe("reconnect_required");
    expect(reservation.message).toContain("連携が切れています");
    expect(reviews.status).toBe("reconnect_required");
  });
});
