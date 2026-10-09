// LINE 通知先の招待・スタッフ本人の LINE ログインによる登録・解除と再登録の世代・切り替え待ちの間の制限の testdb テスト。
// 隔離したテスト用 Supabase(実 Postgres・複数接続)と擬似 LINE ログインで検証する(本物の LINE には接続しない)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { setupNotificationsTestEnv, openDirectConnections, closeConnections } from "./setupNotificationsEnv";
import {
  browserClient,
  createTestLineConnection,
  createTestSalon,
  notificationsTestAdminClient,
  type TestSalonFixture,
} from "./notificationsFixtures";
import { activateNonLegacy } from "./googleFixtures";
import { inbox, reservationMail } from "./mailboxFixtures";

const target = setupNotificationsTestEnv();
process.env.NEXT_PUBLIC_APP_MODE = "salonpack";
const admin = notificationsTestAdminClient();
const flow = await import("@/lib/notifications/line/login/flow");
const recipientsDb = await import("@/lib/notifications/recipients/db");
const { generateInviteToken, hashInviteToken } = await import("@/lib/notifications/recipients/invites");
const { createSimulatedLineLogin, simulatedLineUserId } = await import("@/lib/notifications/line/login/simulated");
const { claimDelivery, beginSend, classifyEmail } = await import("@/lib/notifications/db/notificationDeliveries");
const { pollMailForSalon } = await import("@/lib/notifications/jobs/pollMailForSalon");
const { dbScanStore } = await import("@/lib/notifications/db/gmailScanState");
const { listLineConnections } = await import("@/lib/notifications/db/lineConnections");
type LineSendResult = import("@/lib/notifications/line/LineClient").LineSendResult;

const PLANS = ["salonpack"];
const USER_A = simulatedLineUserId(`a-${Date.now()}`);
const USER_B = simulatedLineUserId(`b-${Date.now()}`);
const USER_C = simulatedLineUserId(`c-${Date.now()}`);
const USER_D = simulatedLineUserId(`d-${Date.now()}`); // 友だち追加をまだしていない人
const sim = createSimulatedLineLogin({
  channelId: "2000000000",
  users: [
    { userId: USER_A, name: "A" },
    { userId: USER_B, name: "B" },
    { userId: USER_C, name: "C" },
    { userId: USER_D, name: "D" },
  ],
});
const config = {
  channelId: sim.channelId,
  channelSecret: "simulated",
  redirectUri: "http://localhost:3999/api/line/login/callback",
  authorizationEndpoint: "http://localhost:3999/api/line/login/simulated-authorize",
  simulated: true,
};
const deps = { transport: sim.transport, config };

let conns: postgres.Sql[] = [];
const salons: TestSalonFixture[] = [];

beforeAll(async () => {
  conns = await openDirectConnections(target, 2);
});
afterAll(async () => {
  for (const s of salons) await s.cleanup();
  await closeConnections(conns);
});

async function newSalon() {
  const salon = await createTestSalon();
  salons.push(salon);
  return salon;
}

async function issueInvite(salon: TestSalonFixture, name: string) {
  const token = generateInviteToken();
  const created = await recipientsDb.createInvite({ salonId: salon.salonId, tokenHash: hashInviteToken(token), displayName: name, userId: salon.userId });
  if (!created.ok) throw new Error("invite");
  return { token, id: created.id };
}

function browser() {
  const value = flow.newBindingValue();
  return flow.bindingHashOf(value)!;
}

/** 招待を開き、画面に表示する進行の id を返す(有効な招待だけ)。 */
async function open(token: string, binding: string): Promise<string> {
  const opened = await flow.openInvite(token, binding);
  if (opened.status !== "valid") throw new Error(`invite ${opened.status}`);
  return opened.flowId;
}

/** 画面の「LINEで連携する」: 進行の id で LINE ログインを始め、認可画面の URL を返す。 */
async function start(flowId: string, binding: string): Promise<string> {
  const url = await flow.startLineLogin(flowId, binding, config);
  if (!url) throw new Error("start refused");
  return url;
}

function stateOf(url: string) {
  return new URL(url).searchParams.get("state");
}

/**
 * 招待を開き(token)、または開いた進行(flowId)から → LINE ログインを始め → 擬似 LINE で許可(またはキャンセル)
 * → コールバック、までの1往復。
 */
async function link(params: { token?: string; flowId?: string; binding: string; userId: string; addFriend?: boolean; cancel?: boolean }) {
  let flowId = params.flowId;
  if (params.token) {
    const opened = await flow.openInvite(params.token, params.binding);
    if (opened.status !== "valid") return { opened: opened.status } as const;
    flowId = opened.flowId;
  }
  const url = await start(flowId!, params.binding);
  if (params.cancel) {
    return flow.completeLineLogin({ state: stateOf(url), code: null, error: "access_denied", bindingHash: params.binding }, deps);
  }
  const { code, state } = sim.approve(url, { userId: params.userId, addFriend: params.addFriend ?? true });
  return flow.completeLineLogin({ state, code, error: null, bindingHash: params.binding }, deps);
}

async function inviteRow(id: string) {
  const { data } = await admin.from("line_recipient_invites").select("used_at, revoked_at, used_line_connection_id").eq("id", id).single();
  return data!;
}

async function connectionsOf(salonId: string) {
  const { data } = await admin
    .from("line_connections")
    .select("id, destination_id, label, status, removed_at, added_via, registration_generation, recipient_since")
    .eq("salon_id", salonId);
  return data ?? [];
}

describe("招待 → スタッフ本人の LINE 連携 → 通知先への追加", () => {
  it("登録すると通知先が作られ、招待は使用済み。結果はサーバーの記録(店舗名は登録した通知先から)で表示する", async () => {
    const salon = await newSalon();
    const invite = await issueInvite(salon, "山田");
    const b = browser();
    expect(await link({ token: invite.token, binding: b, userId: USER_A })).toMatchObject({ kind: "outcome", outcome: "registered" });
    const [row] = await connectionsOf(salon.salonId);
    expect(row).toMatchObject({ destination_id: USER_A, label: "山田", status: "connected", removed_at: null, added_via: "invite", registration_generation: 1 });
    expect(row.recipient_since).toBeTruthy();
    expect((await inviteRow(invite.id)).used_at).toBeTruthy();
    const { data: f } = await admin.from("line_invite_flows").select("id").eq("invite_id", invite.id).single();
    const view = await flow.flowView(f!.id, b);
    expect(view).toMatchObject({ lastOutcome: "registered", registeredSalonName: "テストDB検証用サロン", inviteStatus: "used" });
    // 使用済みの招待は、別の人には使えない。
    expect(await flow.openInvite(invite.token, browser())).toEqual({ status: "used" });
  });

  it("期限切れ・取消済み・不正な招待は開けない(招待はそのまま)", async () => {
    const salon = await newSalon();
    const expired = await issueInvite(salon, "期限切れ");
    await admin.from("line_recipient_invites").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", expired.id);
    expect(await flow.openInvite(expired.token, browser())).toEqual({ status: "expired" });
    const revoked = await issueInvite(salon, "取消");
    expect(await recipientsDb.revokeInvite(salon.salonId, revoked.id, salon.userId)).toBe("revoked");
    expect(await flow.openInvite(revoked.token, browser())).toEqual({ status: "revoked" });
    expect(await flow.openInvite(generateInviteToken(), browser())).toEqual({ status: "not_found" });
    expect(await flow.openInvite("not-a-token", browser())).toEqual({ status: "not_found" });
    expect(await connectionsOf(salon.salonId)).toHaveLength(0);
  });

  it("LINE を開いている間に招待が期限切れになったら、登録せず招待も使用済みにしない", async () => {
    const salon = await newSalon();
    const invite = await issueInvite(salon, "途中で期限切れ");
    const b = browser();
    const url = await start(await open(invite.token, b), b);
    await admin.from("line_recipient_invites").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", invite.id);
    const { code, state } = sim.approve(url, { userId: USER_A });
    expect(await flow.completeLineLogin({ state, code, error: null, bindingHash: b }, deps)).toMatchObject({ kind: "outcome", outcome: "invite_invalid" });
    expect((await inviteRow(invite.id)).used_at).toBeNull();
    expect(await connectionsOf(salon.salonId)).toHaveLength(0);
  });

  it("キャンセル・友だち未追加・途中の通信の失敗では招待を失効させず、同じブラウザから再試行できる", async () => {
    const salon = await newSalon();
    const invite = await issueInvite(salon, "再試行");
    const b = browser();
    const flowId = await open(invite.token, b);
    expect(await link({ flowId, binding: b, userId: USER_D, cancel: true })).toEqual({ kind: "outcome", outcome: "cancelled", flowId });
    expect((await flow.flowView(flowId, b))!.lastOutcome).toBe("cancelled");
    expect(await link({ flowId, binding: b, userId: USER_D, addFriend: false })).toMatchObject({ kind: "outcome", outcome: "not_friend" });
    sim.failNext("exchange");
    expect(await link({ flowId, binding: b, userId: USER_D })).toMatchObject({ kind: "outcome", outcome: "temporary_failure" });
    sim.failNext("friendship");
    expect(await link({ flowId, binding: b, userId: USER_D })).toMatchObject({ kind: "outcome", outcome: "temporary_failure" });
    expect((await inviteRow(invite.id)).used_at).toBeNull();
    expect(await connectionsOf(salon.salonId)).toHaveLength(0);
    // 再試行(生の招待の値は不要。画面の進行の id と cookie から再開)。
    expect(await link({ flowId, binding: b, userId: USER_D })).toMatchObject({ kind: "outcome", outcome: "registered", flowId });
  });

  it("state は1回だけ。別のブラウザ(cookie が違う)からのコールバックは受け付けず、招待には触れない", async () => {
    const salon = await newSalon();
    const invite = await issueInvite(salon, "state");
    const b = browser();
    const flowId = await open(invite.token, b);
    const url = await start(flowId, b);
    const { code, state } = sim.approve(url, { userId: USER_A });
    // 別のブラウザ: どの進行のものかも返さない。
    expect(await flow.completeLineLogin({ state, code, error: null, bindingHash: browser() }, deps)).toEqual({ kind: "state_invalid", flowId: null });
    expect(await flow.completeLineLogin({ state, code, error: null, bindingHash: b }, deps)).toEqual({ kind: "outcome", outcome: "registered", flowId });
    // 同じブラウザでの再利用(戻るボタンなど): 使えないが、同じ招待の結果ページへ戻す。
    expect(await flow.completeLineLogin({ state, code, error: null, bindingHash: b }, deps)).toEqual({ kind: "state_invalid", flowId });
    expect(await flow.completeLineLogin({ state: "x", code, error: null, bindingHash: b }, deps)).toEqual({ kind: "state_invalid", flowId: null });
  });

  it("同じ招待に2人が同時に来ても、登録されるのは1人だけ", async () => {
    const salon = await newSalon();
    const invite = await issueInvite(salon, "同時");
    const [b1, b2] = [browser(), browser()];
    const url1 = await start(await open(invite.token, b1), b1);
    const url2 = await start(await open(invite.token, b2), b2);
    const p1 = sim.approve(url1, { userId: USER_A });
    const p2 = sim.approve(url2, { userId: USER_B });
    const results = await Promise.all([
      flow.completeLineLogin({ ...p1, error: null, bindingHash: b1 }, deps),
      flow.completeLineLogin({ ...p2, error: null, bindingHash: b2 }, deps),
    ]);
    const outcomes = results.map((r) => (r.kind === "outcome" ? r.outcome : r.kind)).sort();
    expect(outcomes).toEqual(["invite_invalid", "registered"]);
    expect(await connectionsOf(salon.salonId)).toHaveLength(1);
  });

  it("同じ LINE の宛先を2つの招待で同時に登録しても1件だけ。もう一方は「登録済み」で、その招待は使わない。既存の通知先は上書きしない", async () => {
    const salon = await newSalon();
    const i1 = await issueInvite(salon, "一つ目");
    const i2 = await issueInvite(salon, "二つ目");
    const [b1, b2] = [browser(), browser()];
    const u1 = await start(await open(i1.token, b1), b1);
    const u2 = await start(await open(i2.token, b2), b2);
    const results = await Promise.all([
      flow.completeLineLogin({ ...sim.approve(u1, { userId: USER_C }), error: null, bindingHash: b1 }, deps),
      flow.completeLineLogin({ ...sim.approve(u2, { userId: USER_C }), error: null, bindingHash: b2 }, deps),
    ]);
    expect(results.map((r) => (r.kind === "outcome" ? r.outcome : r.kind)).sort()).toEqual(["already_registered", "registered"]);
    const rows = await connectionsOf(salon.salonId);
    expect(rows).toHaveLength(1);
    const usedCount = [await inviteRow(i1.id), await inviteRow(i2.id)].filter((r) => r.used_at).length;
    expect(usedCount).toBe(1);
    // 後から3つ目の招待で同じ LINE が来ても、表示名を上書きしない。
    const label = rows[0].label;
    const i3 = await issueInvite(salon, "上書きしない");
    expect(await link({ token: i3.token, binding: browser(), userId: USER_C })).toMatchObject({ kind: "outcome", outcome: "already_registered" });
    expect((await connectionsOf(salon.salonId))[0].label).toBe(label);
    expect((await inviteRow(i3.id)).used_at).toBeNull();
  });
});

describe("同じブラウザの別のタブで開いた別の招待と取り違えない(表示した招待に、開始・state・コールバック・結果・再試行を結び付ける)", () => {
  /** 同じブラウザ(cookie)で、A店・B店の招待を順に開く。 */
  async function twoShopsInOneBrowser() {
    const a = await newSalon();
    const b = await newSalon();
    await admin.from("salons").update({ name: "A店" }).eq("id", a.salonId);
    await admin.from("salons").update({ name: "B店" }).eq("id", b.salonId);
    const inviteA = await issueInvite(a, "Aのスタッフ");
    const inviteB = await issueInvite(b, "Bのスタッフ");
    const binding = browser();
    const flowA = await open(inviteA.token, binding); // タブ1
    const flowB = await open(inviteB.token, binding); // タブ2(あとから開いた)
    return { a, b, inviteA, inviteB, binding, flowA, flowB };
  }

  async function destinationsOf(salonId: string) {
    return (await connectionsOf(salonId)).map((r) => r.destination_id);
  }

  it("A → B の順に開き、A の画面から連携を始めると、A の招待で登録される(B には触れない)", async () => {
    const t = await twoShopsInOneBrowser();
    expect(t.flowA).not.toBe(t.flowB);
    const url = await start(t.flowA, t.binding);
    const { code, state } = sim.approve(url, { userId: USER_A });
    expect(await flow.completeLineLogin({ state, code, error: null, bindingHash: t.binding }, deps)).toEqual({ kind: "outcome", outcome: "registered", flowId: t.flowA });
    expect(await destinationsOf(t.a.salonId)).toEqual([USER_A]);
    expect(await destinationsOf(t.b.salonId)).toEqual([]);
    expect((await inviteRow(t.inviteA.id)).used_at).toBeTruthy();
    expect((await inviteRow(t.inviteB.id)).used_at).toBeNull();
    expect(await flow.flowView(t.flowA, t.binding)).toMatchObject({ lastOutcome: "registered", registeredSalonName: "A店", salonName: "A店" });
    expect(await flow.flowView(t.flowB, t.binding)).toMatchObject({ lastOutcome: null, salonName: "B店", displayName: "Bのスタッフ", inviteStatus: "valid" });
  });

  it("A と B の LINE ログインを並行して進め、逆の順(B → A)で戻っても、それぞれの招待で登録される", async () => {
    const t = await twoShopsInOneBrowser();
    const urlA = await start(t.flowA, t.binding);
    const urlB = await start(t.flowB, t.binding);
    const backA = sim.approve(urlA, { userId: USER_A });
    const backB = sim.approve(urlB, { userId: USER_B });
    expect(await flow.completeLineLogin({ ...backB, error: null, bindingHash: t.binding }, deps)).toEqual({ kind: "outcome", outcome: "registered", flowId: t.flowB });
    expect(await flow.completeLineLogin({ ...backA, error: null, bindingHash: t.binding }, deps)).toEqual({ kind: "outcome", outcome: "registered", flowId: t.flowA });
    expect(await destinationsOf(t.a.salonId)).toEqual([USER_A]);
    expect(await destinationsOf(t.b.salonId)).toEqual([USER_B]);
    expect(await flow.flowView(t.flowA, t.binding)).toMatchObject({ registeredSalonName: "A店", registeredLabel: "Aのスタッフ" });
    expect(await flow.flowView(t.flowB, t.binding)).toMatchObject({ registeredSalonName: "B店", registeredLabel: "Bのスタッフ" });
  });

  it("片方のキャンセル・再試行は、もう片方の結果に影響しない", async () => {
    const t = await twoShopsInOneBrowser();
    const urlA = await start(t.flowA, t.binding);
    const urlB = await start(t.flowB, t.binding);
    // A はキャンセル、B は登録。
    expect(await flow.completeLineLogin({ state: stateOf(urlA), code: null, error: "access_denied", bindingHash: t.binding }, deps)).toEqual({
      kind: "outcome",
      outcome: "cancelled",
      flowId: t.flowA,
    });
    const backB = sim.approve(urlB, { userId: USER_B });
    expect(await flow.completeLineLogin({ ...backB, error: null, bindingHash: t.binding }, deps)).toMatchObject({ outcome: "registered", flowId: t.flowB });
    const { data: before } = await admin.from("line_invite_flows").select("last_outcome, last_outcome_at, line_connection_id").eq("id", t.flowB).single();
    expect(await flow.flowView(t.flowA, t.binding)).toMatchObject({ lastOutcome: "cancelled", salonName: "A店", inviteStatus: "valid" });

    // A の再試行(A の画面の id で始める): A の招待で登録され、B の結果は変わらない。
    expect(await link({ flowId: t.flowA, binding: t.binding, userId: USER_C })).toEqual({ kind: "outcome", outcome: "registered", flowId: t.flowA });
    expect(await destinationsOf(t.a.salonId)).toEqual([USER_C]);
    expect(await destinationsOf(t.b.salonId)).toEqual([USER_B]);
    const { data: after } = await admin.from("line_invite_flows").select("last_outcome, last_outcome_at, line_connection_id").eq("id", t.flowB).single();
    expect(after).toEqual(before);

    // 同じ招待を2つのタブで開いた場合も、片方のキャンセルで、もう片方の「登録済み」を上書きしない。
    const urlA2 = await flow.startLineLogin(t.flowA, t.binding, config);
    expect(urlA2).toBeNull(); // 登録が済んだ招待では、もう始めない
    await conns[0]`select public.line_flow_record_outcome(${t.flowA}::uuid, 'cancelled')`;
    expect(await flow.flowView(t.flowA, t.binding)).toMatchObject({ lastOutcome: "registered" });
  });

  it("再読み込み(同じ id で何度表示しても)で、あとから開いた別の招待に切り替わらない", async () => {
    const t = await twoShopsInOneBrowser();
    for (let i = 0; i < 3; i++) {
      expect(await flow.flowView(t.flowA, t.binding)).toMatchObject({ flowId: t.flowA, salonName: "A店", displayName: "Aのスタッフ" });
    }
    // B の結果が先に出ても、A の画面は A のまま。
    await link({ flowId: t.flowB, binding: t.binding, userId: USER_B });
    expect(await flow.flowView(t.flowA, t.binding)).toMatchObject({ flowId: t.flowA, salonName: "A店", lastOutcome: null });
    // 同じ招待をもう一度開くと、同じ進行(同じ id)を使い直す。
    expect(await open(t.inviteA.token, t.binding)).toBe(t.flowA);
  });

  it("画面から送られた id は、cookie との対応・期限・招待の状態を DB で確かめる(別のブラウザ・改ざん・期限切れは拒否し、state を作らない)", async () => {
    const t = await twoShopsInOneBrowser();
    const statesBefore = (await conns[0]`select count(*)::int as n from public.line_login_states where flow_id in (${t.flowA}::uuid, ${t.flowB}::uuid)`)[0].n;
    // 別のブラウザ(cookie が違う)。
    expect(await flow.flowView(t.flowA, browser())).toBeNull();
    expect(await flow.startLineLogin(t.flowA, browser(), config)).toBeNull();
    // cookie が無い・形の違う id・存在しない id。
    expect(await flow.startLineLogin(t.flowA, null, config)).toBeNull();
    expect(await flow.startLineLogin("not-a-flow-id", t.binding, config)).toBeNull();
    expect(await flow.startLineLogin(`${t.flowA}' or '1'='1`, t.binding, config)).toBeNull();
    expect(await flow.startLineLogin(crypto.randomUUID(), t.binding, config)).toBeNull();
    expect(await flow.flowView(crypto.randomUUID(), t.binding)).toBeNull();
    // 招待の取り消し・進行の期限切れ。
    expect(await recipientsDb.revokeInvite(t.b.salonId, t.inviteB.id, t.b.userId)).toBe("revoked");
    expect(await flow.startLineLogin(t.flowB, t.binding, config)).toBeNull();
    expect(await flow.flowView(t.flowB, t.binding)).toMatchObject({ inviteStatus: "revoked" });
    await admin.from("line_invite_flows").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", t.flowA);
    expect(await flow.startLineLogin(t.flowA, t.binding, config)).toBeNull();
    const statesAfter = (await conns[0]`select count(*)::int as n from public.line_login_states where flow_id in (${t.flowA}::uuid, ${t.flowB}::uuid)`)[0].n;
    expect(statesAfter).toBe(statesBefore);
    expect(await connectionsOf(t.a.salonId)).toHaveLength(0);
    expect(await connectionsOf(t.b.salonId)).toHaveLength(0);
  });
});

describe("他の店舗の招待・通知先には触れない", () => {
  it("別の店舗のオーナーは、取消・再発行・変更・解除ができない。同じ LINE を2つの店舗に登録しても互いに影響しない", async () => {
    const a = await newSalon();
    const b = await newSalon();
    const inviteA = await issueInvite(a, "A店の招待");
    expect(await recipientsDb.revokeInvite(b.salonId, inviteA.id, b.userId)).toBe("not_found");
    expect((await recipientsDb.reissueInvite({ salonId: b.salonId, inviteId: inviteA.id, tokenHash: hashInviteToken(generateInviteToken()), userId: b.userId })).outcome).toBe("not_found");
    expect((await inviteRow(inviteA.id)).revoked_at).toBeNull();

    await link({ token: inviteA.token, binding: browser(), userId: USER_A });
    const inviteB = await issueInvite(b, "B店の招待");
    await link({ token: inviteB.token, binding: browser(), userId: USER_A });
    const [rowA] = await connectionsOf(a.salonId);
    const [rowB] = await connectionsOf(b.salonId);
    expect(rowA.id).not.toBe(rowB.id);
    expect(await recipientsDb.updateRecipient({ salonId: b.salonId, connectionId: rowA.id, newReservationEnabled: false })).toBe("not_found");
    expect(await recipientsDb.removeRecipient(b.salonId, rowA.id, "owner:b")).toBe("not_found");
    expect(await recipientsDb.removeRecipient(b.salonId, rowB.id, "owner:b")).toBe("removed");
    expect((await connectionsOf(a.salonId))[0]).toMatchObject({ status: "connected", removed_at: null });
  });
});

describe("解除・再登録: 解除前の配信を、再登録のあとに送信・再試行しない", () => {
  async function activeSalonWithRecipient() {
    const salon = await newSalon();
    const invite = await issueInvite(salon, "スタッフ");
    await link({ token: invite.token, binding: browser(), userId: USER_B });
    await activateNonLegacy(salon.salonId, new Date(Date.now() - 3 * 24 * 3600_000));
    const [row] = await connectionsOf(salon.salonId);
    return { salon, connectionId: row.id };
  }

  async function insertDelivery(salonId: string, connectionId: string, overrides: Record<string, unknown> = {}) {
    const { data, error } = await admin
      .from("notification_deliveries")
      .insert({
        salon_id: salonId,
        provider_message_id: `gen-${crypto.randomUUID()}`,
        line_connection_id: connectionId,
        destination_id: USER_B,
        event_type: "new_reservation",
        line_text: "予約",
        mail_received_at: new Date().toISOString(),
        ...overrides,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  }

  async function delivery(id: string) {
    const { data } = await admin.from("notification_deliveries").select("status, skip_reason, retry_stopped_at, first_attempt_at").eq("id", id).single();
    return data!;
  }

  async function reRegister(salon: TestSalonFixture) {
    const invite = await issueInvite(salon, "再登録");
    return link({ token: invite.token, binding: browser(), userId: USER_B });
  }

  it("解除: 送信を始めていない配信は skipped、送信を試みた配信は状態を変えずに再試行を止める", async () => {
    const { salon, connectionId } = await activeSalonWithRecipient();
    const pending = await insertDelivery(salon.salonId, connectionId);
    const unknown = await insertDelivery(salon.salonId, connectionId, { status: "unknown", first_attempt_at: new Date().toISOString(), next_attempt_at: new Date(Date.now() - 1000).toISOString() });
    expect(await recipientsDb.removeRecipient(salon.salonId, connectionId, "owner")).toBe("removed");
    expect(await delivery(pending)).toMatchObject({ status: "skipped", skip_reason: "recipient_removed" });
    const u = await delivery(unknown);
    expect(u.status).toBe("unknown"); // 送ったかもしれない記録は書き換えない
    expect(u.retry_stopped_at).toBeTruthy();
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
    expect((await recipientsDb.listRecipients(salon.salonId)).map((r) => r.id)).not.toContain(connectionId);
  });

  it("取り出し → 解除 → 送信直前の確認: 送らない(初回なので skipped)", async () => {
    const { salon, connectionId } = await activeSalonWithRecipient();
    const id = await insertDelivery(salon.salonId, connectionId);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    expect(claimed!.id).toBe(id);
    await recipientsDb.removeRecipient(salon.salonId, connectionId, "owner");
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "skipped", reason: "recipient_removed" });
  });

  it("取り出し → 解除 → 再登録 → 古い処理の再開: 世代が違うので送らない", async () => {
    const { salon, connectionId } = await activeSalonWithRecipient();
    await insertDelivery(salon.salonId, connectionId);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    await recipientsDb.removeRecipient(salon.salonId, connectionId, "owner");
    expect(await reRegister(salon)).toMatchObject({ kind: "outcome", outcome: "registered" });
    const [row] = await connectionsOf(salon.salonId);
    expect(row).toMatchObject({ id: connectionId, registration_generation: 2, status: "connected", removed_at: null });
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "skipped", reason: "recipient_reregistered" });
  });

  it("結果不明 → 解除 → 再登録 → 再試行: 取り出されない。止める印が無くても(競合)送信直前の確認で止め、状態は書き換えない", async () => {
    const { salon, connectionId } = await activeSalonWithRecipient();
    const id = await insertDelivery(salon.salonId, connectionId, { status: "unknown", first_attempt_at: new Date().toISOString(), next_attempt_at: new Date(Date.now() - 1000).toISOString() });
    await recipientsDb.removeRecipient(salon.salonId, connectionId, "owner");
    await reRegister(salon);
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
    // 競合で止める印が付かなかった場合を再現する。
    await admin.from("notification_deliveries").update({ retry_stopped_at: null, retry_stop_reason: null }).eq("id", id);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    expect(claimed!.id).toBe(id);
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "released", reason: "retry_stopped:recipient_reregistered" });
    expect(await delivery(id)).toMatchObject({ status: "unknown" });
    expect((await delivery(id)).retry_stopped_at).toBeTruthy();
  });

  it("解除前の受信者の一覧を持つ分類処理: 解除済みの人の配信は作らない。再登録より前に届いたメールも送らない", async () => {
    const { salon, connectionId } = await activeSalonWithRecipient();
    const staleRecipients = [{ lineConnectionId: connectionId, destinationId: USER_B }];
    await recipientsDb.removeRecipient(salon.salonId, connectionId, "owner");
    const classifyWith = async (receivedAt: Date) => {
      const { data } = await admin
        .from("processed_emails")
        .insert({ salon_id: salon.salonId, provider_message_id: `cls-${crypto.randomUUID()}`, event_type: "pending", classify_attempts: 1 })
        .select("id, provider_message_id")
        .single();
      const created = await classifyEmail({ processedId: data!.id, eventType: "new_reservation", lineText: "予約", mailReceivedAt: receivedAt, recipients: staleRecipients });
      return { created, messageId: data!.provider_message_id as string };
    };
    expect((await classifyWith(new Date())).created).toBe(0);
    const beforeReRegistration = new Date();
    await new Promise((r) => setTimeout(r, 50));
    await reRegister(salon);
    expect((await classifyWith(beforeReRegistration)).created).toBe(0); // 登録より前に届いたメール
    const after = await classifyWith(new Date(Date.now() + 1000));
    expect(after.created).toBe(1);
    const { data: d } = await admin.from("notification_deliveries").select("recipient_generation").eq("provider_message_id", after.messageId).single();
    expect(d!.recipient_generation).toBe(2);
  });

  it("口コミ通知の設定(口コミブランチの表)は、解除・再登録で OFF にし、勝手に ON にしない(トランザクションの中で確かめて取り消す)", async () => {
    const { salon, connectionId } = await activeSalonWithRecipient();
    const sql = conns[0];
    class Rollback extends Error {}
    await sql
      .begin(async (tx) => {
        // テスト用DBには口コミブランチの表(0014)がある。行の変更はトランザクションごと取り消す。
        await tx`insert into public.line_notification_preferences (line_connection_id, new_review_enabled) values (${connectionId}, true)
                 on conflict (line_connection_id) do update set new_review_enabled = true`;
        await tx`select public.line_recipient_remove(${salon.salonId}::uuid, ${connectionId}::uuid, 'owner')`;
        const [afterRemove] = await tx`select new_review_enabled from public.line_notification_preferences where line_connection_id = ${connectionId}`;
        expect(afterRemove.new_review_enabled).toBe(false);
        // 再登録の前に誰かが ON にしていても、再登録で OFF に戻る(口コミの通知を勝手に送らない)。
        await tx`update public.line_notification_preferences set new_review_enabled = true where line_connection_id = ${connectionId}`;
        const token = generateInviteToken();
        await tx`select * from public.line_invite_create(${salon.salonId}::uuid, ${hashInviteToken(token)}, '再登録', ${salon.userId}::uuid)`;
        const binding = flow.bindingHashOf(flow.newBindingValue())!;
        const [started] = await tx`select * from public.line_flow_start(${hashInviteToken(token)}, ${binding})`;
        const [redeemed] = await tx`select * from public.line_invite_redeem(${started.flow_id}::uuid, ${USER_B})`;
        expect(redeemed.outcome).toBe("registered");
        const [afterRedeem] = await tx`select new_review_enabled from public.line_notification_preferences where line_connection_id = ${connectionId}`;
        expect(afterRedeem.new_review_enabled).toBe(false);
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
    const left = await conns[0]`select 1 from public.line_notification_preferences where line_connection_id = ${connectionId}`;
    expect(left).toHaveLength(0);
  });
});

describe("切り替え待ちの店舗: 旧側で使われている通知先・全体スイッチは変更できない。追加しても稼働しない", () => {
  it("由来(移行の記録)で判定し、画面用の一覧・DB の判定が一致する。新規追加先の解除・招待の取消はできる。運用状態は変わらない", async () => {
    const salon = await newSalon();
    const legacyId = crypto.randomUUID();
    await admin.from("line_connections").insert({
      id: legacyId,
      salon_id: salon.salonId,
      destination_id: `U${"d".repeat(32)}`,
      label: "引き継ぎスタッフ",
      status: "connected",
      migrated_from_hmail_salon_id: legacyId,
    });
    await admin.from("salon_feature_selections").upsert({ salon_id: salon.salonId, feature_key: "reservation_notifications", selected: true }, { onConflict: "salon_id,feature_key" });
    await admin.from("reservation_notification_operations").upsert({ salon_id: salon.salonId, state: "awaiting_cutover", legacy_source: "hmail" }, { onConflict: "salon_id" });
    const { data: before } = await admin.from("reservation_notification_operations").select("*").eq("salon_id", salon.salonId).single();
    const { data: planBefore } = await admin.from("salons").select("plan").eq("id", salon.salonId).single();

    const invite = await issueInvite(salon, "新しいスタッフ");
    expect(await link({ token: invite.token, binding: browser(), userId: USER_A })).toMatchObject({ kind: "outcome", outcome: "registered" });
    const list = await recipientsDb.listRecipients(salon.salonId);
    const legacy = list.find((r) => r.id === legacyId)!;
    const added = list.find((r) => r.id !== legacyId)!;
    expect(legacy).toMatchObject({ origin: "legacy", changeLocked: true });
    expect(added).toMatchObject({ origin: "invite", changeLocked: false });

    expect(await recipientsDb.updateRecipient({ salonId: salon.salonId, connectionId: legacyId, newReservationEnabled: false })).toBe("locked");
    expect(await recipientsDb.removeRecipient(salon.salonId, legacyId, "owner")).toBe("locked");
    expect(await recipientsDb.updateRecipient({ salonId: salon.salonId, connectionId: legacyId, label: "表示名だけは変更できる" })).toBe("updated");
    expect(await recipientsDb.setMasterEnabled(salon.salonId, false)).toBe("locked");
    expect(await recipientsDb.isSalonLockedForCutover(salon.salonId)).toBe(true);
    expect(await recipientsDb.updateRecipient({ salonId: salon.salonId, connectionId: added.id, cancellationEnabled: false })).toBe("updated");
    const pending = await issueInvite(salon, "取り消す招待");
    expect(await recipientsDb.revokeInvite(salon.salonId, pending.id, salon.userId)).toBe("revoked");
    expect(await recipientsDb.removeRecipient(salon.salonId, added.id, "owner")).toBe("removed");

    const { data: after } = await admin.from("reservation_notification_operations").select("*").eq("salon_id", salon.salonId).single();
    expect(after).toEqual(before); // 招待・登録・解除で運用状態は一切変わらない(稼働しない)
    expect((await admin.from("salons").select("plan").eq("id", salon.salonId).single()).data).toEqual(planBefore);
    const { count } = await admin.from("salon_google_bindings").select("salon_id", { count: "exact", head: true }).eq("salon_id", salon.salonId);
    expect(count).toBe(0);

    // 稼働後は、引き継いだ通知先も変更できる(制限は切り替え待ちの間だけ)。
    await admin.from("reservation_notification_operations").update({ state: "paused" }).eq("salon_id", salon.salonId);
    expect(await recipientsDb.updateRecipient({ salonId: salon.salonId, connectionId: legacyId, newReservationEnabled: false })).toBe("updated");
  });
});

describe("ブラウザからのアクセス拒否(RLS・権限の取り消し)", () => {
  it("anon と、ログインしたお客様のどちらでも、招待・連携の進行・state の表と関数に触れない", async () => {
    const salon = await newSalon();
    const invite = await issueInvite(salon, "RLS");
    const clients = [await browserClient(), await browserClient({ email: salon.email, password: salon.password })];
    for (const client of clients) {
      for (const table of ["line_recipient_invites", "line_invite_flows", "line_login_states"]) {
        const { data, error } = await client.from(table).select("*").limit(1);
        expect(error !== null || (data ?? []).length === 0).toBe(true);
        expect(error?.code ?? "42501").toBe("42501");
      }
      for (const [fn, args] of [
        ["line_invite_lookup", { p_token_hash: hashInviteToken(invite.token) }],
        ["line_flow_get", { p_flow_id: crypto.randomUUID(), p_binding_hash: "0".repeat(64) }],
        ["line_login_state_flow", { p_state_hash: "0".repeat(64), p_binding_hash: "0".repeat(64) }],
        ["line_recipient_list", { p_salon_id: salon.salonId }],
        ["line_invite_revoke", { p_salon_id: salon.salonId, p_invite_id: invite.id, p_by: salon.userId }],
        ["line_recipient_remove", { p_salon_id: salon.salonId, p_connection_id: crypto.randomUUID(), p_by: "x" }],
        ["notification_settings_set_master", { p_salon_id: salon.salonId, p_enabled: false }],
        ["notifications_release_claim", { p_id: crypto.randomUUID(), p_claim_token: crypto.randomUUID() }],
      ] as const) {
        const { error } = await client.rpc(fn, args);
        expect(error, fn).not.toBeNull();
      }
    }
    expect((await inviteRow(invite.id)).revoked_at).toBeNull();
  });
});

describe("配信: 通知先ごとに1回ずつ。1人だけ失敗したら、その人だけを同じ retry key で再試行する", () => {
  it("3人の通知先、1人だけ結果不明 → 次の回はその人だけ同じ key で送る。解除済みの通知先には送らない", async () => {
    const salon = await newSalon();
    const lines = [
      await createTestLineConnection(salon.salonId, { label: "1" }),
      await createTestLineConnection(salon.salonId, { label: "2" }),
      await createTestLineConnection(salon.salonId, { label: "3" }),
    ];
    const removed = await createTestLineConnection(salon.salonId, { label: "解除済み" });
    await recipientsDb.removeRecipient(salon.salonId, removed, "owner");
    await activateNonLegacy(salon.salonId);
    const { data: dest } = await admin.from("line_connections").select("id, destination_id").in("id", lines);
    const failing = dest!.find((d) => d.id === lines[1])!.destination_id as string;
    const calls: Array<{ destination: string; retryKey: string }> = [];
    let failOnce = true;
    const sendLine = async (destination: string, _t: string, retryKey: string): Promise<LineSendResult> => {
      calls.push({ destination, retryKey });
      if (destination === failing && failOnce) {
        failOnce = false;
        return { outcome: "unknown", reason: "http_500" };
      }
      return { outcome: "sent", requestId: `r-${calls.length}` };
    };
    const messageId = `fanout-${crypto.randomUUID()}`;
    const params = {
      salonId: salon.salonId,
      accountId: "00000000-0000-0000-0000-000000000000",
      initialWatermark: new Date(Date.now() - 3600_000),
      recipients: await listLineConnections(salon.salonId),
    };
    const pollDeps = {
      provider: inbox({ [messageId]: reservationMail(new Date()) }),
      scanStore: dbScanStore,
      sendLine,
      allowedPlans: PLANS,
    };
    // 取得状況の行が要るため、テスト用の Google アカウントを作らずに済むよう取得は止め、分類は直接行う。
    const { data: processed } = await admin
      .from("processed_emails")
      .insert({ salon_id: salon.salonId, provider_message_id: messageId, event_type: "pending", classify_attempts: 1 })
      .select("id")
      .single();
    await classifyEmail({
      processedId: processed!.id,
      eventType: "new_reservation",
      lineText: "予約",
      mailReceivedAt: new Date(),
      recipients: [...params.recipients.map((r) => ({ lineConnectionId: r.id, destinationId: r.destinationId! })), { lineConnectionId: removed, destinationId: "U_removed" }],
    });
    await pollMailForSalon({ ...params, readMail: false }, pollDeps);
    expect(calls).toHaveLength(3);
    const firstKey = calls.find((c) => c.destination === failing)!.retryKey;
    await admin.from("notification_deliveries").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("provider_message_id", messageId).eq("status", "unknown");
    await pollMailForSalon({ ...params, readMail: false }, pollDeps);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual({ destination: failing, retryKey: firstKey });
    const { data: rows } = await admin.from("notification_deliveries").select("line_connection_id, status").eq("provider_message_id", messageId);
    expect(rows!.map((r) => r.line_connection_id).sort()).toEqual([...lines].sort()); // 解除済みの通知先の配信は作らない
    expect(rows!.every((r) => r.status === "sent")).toBe(true);
  });
});
