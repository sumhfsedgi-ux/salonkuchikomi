// 予約通知の配信の信頼性(処理権・同じ retry key・送信直前の確認・遅延通知のルール)の回帰テスト。
// 隔離したテスト用 Supabase(実 Postgres、複数の接続)に対して実行する。Gmail・LINE はモック。
// npm run test:testdb で実行。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { setupNotificationsTestEnv, openDirectConnections, closeConnections } from "./setupNotificationsEnv";
import { createTestSalon, createTestLineConnection, setMasterEnabled, type TestSalonFixture } from "./notificationsFixtures";
import { activateNonLegacy, createTestGoogleAccount, deleteTestGoogleAccounts } from "./googleFixtures";

const target = setupNotificationsTestEnv();

const { pollMailForSalon } = await import("@/lib/notifications/jobs/pollMailForSalon");
const { claimDelivery, beginSend, finishDelivery } = await import("@/lib/notifications/db/notificationDeliveries");
const { dbScanStore } = await import("@/lib/notifications/db/gmailScanState");
const { listLineConnections } = await import("@/lib/notifications/db/lineConnections");
const admin = (await import("./notificationsFixtures")).notificationsTestAdminClient();

const PLANS = ["salonpack"];
const HOTPEPPER_FROM = "SALON BOARD <yoyaku_system@salonboard.com>";

type Mail = { from: string; subject: string; bodyText: string; receivedAt: Date | null };
function mockProvider(messages: Record<string, Mail>) {
  return {
    async listPage() {
      return { ids: Object.keys(messages), nextPageToken: null };
    },
    async getMessage(id: string) {
      const m = messages[id];
      if (!m) throw new Error(`mock: no message ${id}`);
      return { id, ...m };
    },
  };
}
const newReservation = (receivedAt = new Date()): Mail => ({ from: HOTPEPPER_FROM, subject: "予約連絡", bodyText: "テスト予約本文", receivedAt });

let conns: postgres.Sql[] = [];
const accounts: string[] = [];

beforeAll(async () => {
  conns = await openDirectConnections(target, 3);
});
afterAll(async () => {
  await deleteTestGoogleAccounts(accounts);
  await closeConnections(conns);
});

async function insertDelivery(salonId: string, lineConnectionId: string, overrides: Record<string, unknown> = {}) {
  const { data: lc } = await admin.from("line_connections").select("destination_id").eq("id", lineConnectionId).single();
  const { data, error } = await admin
    .from("notification_deliveries")
    .insert({
      salon_id: salonId,
      provider_message_id: `msg-${crypto.randomUUID()}`,
      line_connection_id: lineConnectionId,
      destination_id: lc!.destination_id,
      event_type: "new_reservation",
      line_text: "テスト本文",
      mail_received_at: new Date().toISOString(),
      ...overrides,
    })
    .select("id, line_retry_key")
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string; line_retry_key: string };
}

/** 前のテストで残った「取り出せる」配信を片付ける(各テストが自分の配信だけを取り出すように)。 */
async function clearClaimable(salonId: string) {
  await admin
    .from("notification_deliveries")
    .update({ status: "skipped", skip_reason: "test_cleanup", claim_token: null, claimed_at: null })
    .eq("salon_id", salonId)
    .in("status", ["pending", "unknown", "retry_wait", "claimed"]);
}

async function deliveryRow(id: string) {
  const { data } = await admin.from("notification_deliveries").select("*").eq("id", id).single();
  return data as Record<string, unknown>;
}

async function activeSalonWithStaff(count = 1, staff: Parameters<typeof createTestLineConnection>[1] = {}) {
  const salon = await createTestSalon();
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(await createTestLineConnection(salon.salonId, { label: `スタッフ${i}`, ...staff }));
  await activateNonLegacy(salon.salonId);
  return { salon, lines };
}

describe("処理権: 同時に取り出しても1つだけ・古い処理は新しい結果を上書きできない", () => {
  let salon: TestSalonFixture;
  let line: string;
  beforeAll(async () => ({ salon, lines: [line] } = await activeSalonWithStaff()));
  afterAll(async () => salon.cleanup());

  it("2本の接続から同時に取り出すと、どちらか一方だけが取れる", async () => {
    await insertDelivery(salon.salonId, line);
    const [a, b] = await Promise.all([
      conns[0]`select * from notifications_claim_delivery_v2(${salon.salonId}::uuid, ${PLANS})`,
      conns[1]`select * from notifications_claim_delivery_v2(${salon.salonId}::uuid, ${PLANS})`,
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it("処理権が切れて別の処理が取り直したら、古い処理の結果は記録されない", async () => {
    const d = await insertDelivery(salon.salonId, line);
    await admin.from("notification_deliveries").update({ status: "skipped" }).eq("salon_id", salon.salonId).neq("id", d.id);
    const first = await claimDelivery(salon.salonId, PLANS);
    expect(first!.id).toBe(d.id);
    // 送信開始前に処理権が切れた(開始していないので元の状態へ戻り、取り直せる)。
    await admin.from("notification_deliveries").update({ claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }).eq("id", d.id);
    const second = await claimDelivery(salon.salonId, PLANS);
    expect(second!.id).toBe(d.id);
    expect(second!.claimToken).not.toBe(first!.claimToken);
    expect(await finishDelivery({ delivery: first!, outcome: "failed", error: "stale" })).toBe(false);
    expect(await finishDelivery({ delivery: second!, outcome: "sent", lineRequestId: "req-1" })).toBe(true);
    expect((await deliveryRow(d.id)).status).toBe("sent");
  });

  it("送信を始めたあとに処理権が切れたら「結果不明」になり(未送信に戻さない)、同じ retry key で再試行する", async () => {
    const d = await insertDelivery(salon.salonId, line);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    expect(claimed!.id).toBe(d.id);
    const decision = await beginSend(claimed!, PLANS);
    expect(decision.decision).toBe("send");
    await admin.from("notification_deliveries").update({ claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }).eq("id", d.id);
    // 別の処理が取り出しを試みると、まず結果不明へ整理される(すぐには再送しない)。
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
    const row = await deliveryRow(d.id);
    expect(row.status).toBe("unknown");
    expect(row.last_error).toBe("lease_expired_after_send_start");
    // 待ち時間のあと、同じ retry key で取り出される。
    await admin.from("notification_deliveries").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", d.id);
    const retry = await claimDelivery(salon.salonId, PLANS);
    const retryDecision = await beginSend(retry!, PLANS);
    expect(retryDecision.decision === "send" && retryDecision.lineRetryKey).toBe(d.line_retry_key);
    // 元の処理(処理権を失った)が遅れて結果を書こうとしても記録されない。
    expect(await finishDelivery({ delivery: claimed!, outcome: "sent" })).toBe(false);
    expect(await finishDelivery({ delivery: retry!, outcome: "sent", lineRequestId: "accepted-id" })).toBe(true);
  });
});

describe("送信直前の確認: 停止・OFF・送信先の変更は初回と再送の両方に効く", () => {
  let salon: TestSalonFixture;
  let line: string;
  beforeAll(async () => ({ salon, lines: [line] } = await activeSalonWithStaff()));
  afterAll(async () => salon.cleanup());

  it("送信直前に停止した店舗の配信は送らず、元の状態へ戻す。停止の直前に送信を始めたものは「送信中」として数える", async () => {
    const inflight = await insertDelivery(salon.salonId, line);
    const pendingAfter = await insertDelivery(salon.salonId, line);
    const a = await claimDelivery(salon.salonId, PLANS);
    expect((await beginSend(a!, PLANS)).decision).toBe("send");
    const b = await claimDelivery(salon.salonId, PLANS);
    // 停止(ロックの解放直後に、送信中の処理が残っている状態)。
    const [{ reservation_ops_pause: count }] = await conns[0]`select reservation_ops_pause(${salon.salonId}::uuid, 'test', 'test', 'operator_pause')`;
    expect(count).toBe(1);
    const decision = await beginSend(b!, PLANS);
    expect(decision).toMatchObject({ decision: "released", reason: "state_paused" });
    expect((await deliveryRow(pendingAfter.id)).status).toBe("pending");
    // 停止後は新しく取り出せない。送信中だったものの結果は記録できる(処理権の失効は送信の取消ではない)。
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
    expect(await finishDelivery({ delivery: a!, outcome: "sent" })).toBe(true);
    expect((await deliveryRow(inflight.id)).status).toBe("sent");
    // 再開(この店舗は Google 連携を作っていないため、開始の関数を通さずに稼働中へ戻す)。
    await activateNonLegacy(salon.salonId);
    await conns[0]`select reservation_close_stop(${salon.salonId}::uuid, 'operator_pause', 'test')`;
  });

  it("取り出してから送るまでの間にスタッフが OFF にしたら送らない(初回)", async () => {
    await clearClaimable(salon.salonId);
    const d = await insertDelivery(salon.salonId, line);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    await admin.from("line_connections").update({ new_reservation_enabled: false }).eq("id", line);
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "skipped", reason: "recipient_toggle_off" });
    expect((await deliveryRow(d.id)).status).toBe("skipped");
    await admin.from("line_connections").update({ new_reservation_enabled: true }).eq("id", line);
  });

  it("結果不明の再送でも OFF が効く。ただし未送信・解決済みには書き換えない", async () => {
    await clearClaimable(salon.salonId);
    const d = await insertDelivery(salon.salonId, line, { status: "unknown", first_attempt_at: new Date(Date.now() - 60_000).toISOString(), next_attempt_at: new Date(Date.now() - 1000).toISOString() });
    await admin.from("line_connections").update({ new_reservation_enabled: false, cancellation_enabled: false }).eq("id", line);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    expect(claimed!.id).toBe(d.id);
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "released", reason: "retry_suppressed:recipient_toggle_off" });
    expect((await deliveryRow(d.id)).status).toBe("unknown");
    await admin.from("line_connections").update({ new_reservation_enabled: true, cancellation_enabled: true }).eq("id", line);
    await admin.from("notification_deliveries").update({ status: "skipped" }).eq("id", d.id);
  });

  it("分類できなかった通知('unknown')は、スタッフの全通知 OFF を迂回しない", async () => {
    await clearClaimable(salon.salonId);
    const d = await insertDelivery(salon.salonId, line, { event_type: "unknown" });
    await admin.from("line_connections").update({ new_reservation_enabled: false, cancellation_enabled: false }).eq("id", line);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "skipped", reason: "recipient_all_off" });
    expect((await deliveryRow(d.id)).status).toBe("skipped");
    await admin.from("line_connections").update({ new_reservation_enabled: true, cancellation_enabled: true }).eq("id", line);
  });

  it("送信先(LINE)が変わっていたら、同じ retry key で別の人へは送らない", async () => {
    await clearClaimable(salon.salonId);
    const d = await insertDelivery(salon.salonId, line);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    const { data: before } = await admin.from("line_connections").select("destination_id").eq("id", line).single();
    await admin.from("line_connections").update({ destination_id: "U_changed_destination" }).eq("id", line);
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "skipped", reason: "destination_changed" });
    expect((await deliveryRow(d.id)).status).toBe("skipped");
    await admin.from("line_connections").update({ destination_id: before!.destination_id }).eq("id", line);
  });
});

describe("遅延通知のルール", () => {
  let salon: TestSalonFixture;
  let line: string;
  beforeAll(async () => {
    ({ salon, lines: [line] } = await activeSalonWithStaff());
    // メール取得開始より前に届いたメールは対象外(before_fetch_start)のため、取得開始を3日前にしておく。
    await activateNonLegacy(salon.salonId, new Date(Date.now() - 3 * 24 * 3600_000));
  });
  afterAll(async () => salon.cleanup());

  async function decideFor(overrides: Record<string, unknown>) {
    await clearClaimable(salon.salonId);
    const d = await insertDelivery(salon.salonId, line, overrides);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    expect(claimed!.id).toBe(d.id);
    return { d, decision: await beginSend(claimed!, PLANS) };
  }

  it("障害で遅れた(停止していない)メールは、受信から24時間以内なら送る・超えたら送らない", async () => {
    expect((await decideFor({ mail_received_at: new Date(Date.now() - 20 * 3600_000).toISOString() })).decision.decision).toBe("send");
    expect((await decideFor({ mail_received_at: new Date(Date.now() - 30 * 3600_000).toISOString() })).decision).toMatchObject({
      decision: "skipped",
      reason: "stale_after_outage",
    });
  });

  it("利用者が通知を OFF にしていた間に届いた予約は、ON に戻しても送らない(24時間以内でも)", async () => {
    await setMasterEnabled(salon.salonId, false);
    await new Promise((r) => setTimeout(r, 50));
    await setMasterEnabled(salon.salonId, true);
    // 停止期間は DB の時刻で記録される(アプリの時計とずれても判定がぶれないよう、記録された期間の中央を使う)。
    const { data: interval } = await admin
      .from("reservation_stop_intervals")
      .select("started_at, ended_at")
      .eq("salon_id", salon.salonId)
      .eq("kind", "manual_master_off")
      .order("started_at", { ascending: false })
      .limit(1)
      .single();
    const during = new Date((new Date(interval!.started_at).getTime() + new Date(interval!.ended_at).getTime()) / 2);
    const { decision } = await decideFor({ mail_received_at: during.toISOString() });
    expect(decision).toMatchObject({ decision: "skipped", reason: "received_while_stopped:manual_master_off" });
  });

  it("送信を試みた結果不明は、期限内なら同じキーで再試行。期限(最初の送信から)を過ぎたら自動では送らず、状態も変えない", async () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    // 作成は古いが最初の送信は最近 → 期限内(期限は最初の送信から数える)。
    const recent = await decideFor({ status: "unknown", created_at: old, mail_received_at: old, first_attempt_at: new Date(Date.now() - 3600_000).toISOString() });
    expect(recent.decision.decision).toBe("send");
    // 最初の送信から24時間を過ぎた結果不明は、取り出されない(自動再送しない)。
    await admin.from("notification_deliveries").update({ status: "skipped" }).eq("salon_id", salon.salonId).in("status", ["claimed"]);
    const expired = await insertDelivery(salon.salonId, line, { status: "unknown", first_attempt_at: old });
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
    expect((await deliveryRow(expired.id)).status).toBe("unknown");
  });

  it("429(混雑)は待ってから再試行し、同じ回にすぐ取り直さない", async () => {
    await admin.from("notification_deliveries").update({ status: "skipped" }).eq("salon_id", salon.salonId).in("status", ["pending", "unknown", "claimed"]);
    const d = await insertDelivery(salon.salonId, line);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    await beginSend(claimed!, PLANS);
    await finishDelivery({ delivery: claimed!, outcome: "retry_wait", retryAfterSeconds: 60 });
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
    expect((await deliveryRow(d.id)).status).toBe("retry_wait");
  });

  it("確認待ち・旧サービスの記録は取り出さない", async () => {
    await admin.from("notification_deliveries").update({ status: "skipped" }).eq("salon_id", salon.salonId).in("status", ["pending", "unknown", "retry_wait"]);
    await insertDelivery(salon.salonId, line, { status: "needs_review" });
    await insertDelivery(salon.salonId, line, { status: "pending", origin: "hmail" });
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
  });
});

describe("分類と配信行の作成は1つのトランザクション(失敗しても取り残されない)", () => {
  let salon: TestSalonFixture;
  beforeAll(async () => ({ salon } = await activeSalonWithStaff()));
  afterAll(async () => salon.cleanup());

  it("分類の記録に失敗したら、配信行も作られず pending のまま残り、後で再クレームされる。上限回数で unprocessable", async () => {
    const { data: row } = await admin
      .from("processed_emails")
      .insert({ salon_id: salon.salonId, provider_message_id: `msg-${crypto.randomUUID()}`, event_type: "pending", classify_attempts: 1 })
      .select("id")
      .single();
    const lines = await listLineConnections(salon.salonId);
    await expect(
      conns[0]`select notifications_classify_email(${row!.id}::uuid, 'not_a_valid_event', 'x', now(), ${conns[0].json([{ line_connection_id: lines[0].id, destination_id: lines[0].destinationId }])}::jsonb)`
    ).rejects.toThrow();
    const { data: after } = await admin.from("processed_emails").select("event_type").eq("id", row!.id).single();
    expect(after!.event_type).toBe("pending");
    const { count } = await admin.from("notification_deliveries").select("id", { count: "exact", head: true }).eq("salon_id", salon.salonId);
    expect(count).toBe(0);

    await admin.from("processed_emails").update({ processed_at: new Date(Date.now() - 3600_000).toISOString(), classify_attempts: 5 }).eq("id", row!.id);
    const [reclaimed] = await conns[0]`select * from notifications_reclaim_stuck_email_v2(${salon.salonId}::uuid)`;
    expect(reclaimed).toBeUndefined();
    const { data: final } = await admin.from("processed_emails").select("event_type").eq("id", row!.id).single();
    expect(final!.event_type).toBe("unprocessable");
  });
});

describe("本番以外の環境: 実送信用のトークンが設定されていても、定期処理は LINE を呼ばず、配信を未送信のまま戻す", () => {
  it("本物の送信の入口(pushText)を使っても SDK の送信は一度も呼ばれない。配信は pending のまま(初回の試行の印も付けない)", async () => {
    const { messagingApi } = await import("@line/bot-sdk");
    const { pushText } = await import("@/lib/notifications/line/LineClient");
    const sdkSend = vi.spyOn(messagingApi.MessagingApiClient.prototype, "pushMessageWithHttpInfo");
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "real-looking-channel-access-token-must-not-be-used");
    try {
      expect(process.env.NODE_ENV).not.toBe("production");
      const { salon, lines } = await activeSalonWithStaff(2);
      const accountId = await createTestGoogleAccount();
      accounts.push(accountId);
      const d1 = await insertDelivery(salon.salonId, lines[0]);
      const d2 = await insertDelivery(salon.salonId, lines[1]);
      const before = [await deliveryRow(d1.id), await deliveryRow(d2.id)];
      const result = await pollMailForSalon(
        { salonId: salon.salonId, accountId, initialWatermark: new Date(Date.now() - 3600_000), recipients: await listLineConnections(salon.salonId), readMail: false },
        { provider: mockProvider({}), scanStore: dbScanStore, sendLine: pushText, allowedPlans: PLANS }
      );
      expect(result).toMatchObject({ sendBlocked: true, releasedBeforeSend: 1, delivered: 0, deliveryUnknown: 0, deliveryFailed: 0 });
      expect(sdkSend).not.toHaveBeenCalled();
      for (const [i, id] of [d1.id, d2.id].entries()) {
        const row = await deliveryRow(id);
        expect(row).toMatchObject({ status: "pending", first_attempt_at: null, send_started_at: null, claim_token: null, attempts: before[i].attempts });
        expect(row.line_retry_key).toBe(before[i].line_retry_key);
      }
      await salon.cleanup();
    } finally {
      vi.unstubAllEnvs();
      sdkSend.mockRestore();
    }
  });
});

describe("pollMailForSalon: 複数スタッフへの配信の途中停止からの再開(重複なし・取り残しなし)", () => {
  let salon: TestSalonFixture;
  let accountId: string;
  beforeAll(async () => {
    ({ salon } = await activeSalonWithStaff(3));
    accountId = await createTestGoogleAccount();
    accounts.push(accountId);
  });
  afterAll(async () => salon.cleanup());

  it("3人中1人に送った直後に止まっても、次の回で残り2人に1回ずつ届く", async () => {
    const messageId = `msg-fanout-${Date.now()}`;
    const provider = mockProvider({ [messageId]: newReservation() });
    const recipients = await listLineConnections(salon.salonId);
    const sent: Array<{ destinationId: string; retryKey: string }> = [];
    const sendLine = async (destinationId: string, _t: string, retryKey: string) => {
      sent.push({ destinationId, retryKey });
      return { outcome: "sent" as const, requestId: `req-${sent.length}` };
    };
    const params = { salonId: salon.salonId, accountId, initialWatermark: new Date(Date.now() - 3600_000), recipients };
    await pollMailForSalon(params, { provider, scanStore: dbScanStore, sendLine, allowedPlans: PLANS, maxDeliveriesPerTick: 1 });
    expect(sent).toHaveLength(1);
    await pollMailForSalon(params, { provider, scanStore: dbScanStore, sendLine, allowedPlans: PLANS, maxDeliveriesPerTick: 10 });
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.destinationId)).size).toBe(3);
    const { data: rows } = await admin.from("notification_deliveries").select("status, line_request_id").eq("provider_message_id", messageId);
    expect(rows!.every((r) => r.status === "sent" && r.line_request_id)).toBe(true);
  });

  it("停止中の店舗は、メールを読んでも配信しない(呼び出し元は停止中の店舗を渡さないが、渡されても送らない)", async () => {
    await conns[0]`select reservation_ops_pause(${salon.salonId}::uuid, 'test', 'test', 'operator_pause')`;
    const messageId = `msg-paused-${Date.now()}`;
    const sent: string[] = [];
    await pollMailForSalon(
      { salonId: salon.salonId, accountId, initialWatermark: new Date(Date.now() - 3600_000), recipients: await listLineConnections(salon.salonId) },
      {
        provider: mockProvider({ [messageId]: newReservation() }),
        scanStore: dbScanStore,
        sendLine: async (d) => {
          sent.push(d);
          return { outcome: "sent", requestId: null };
        },
        allowedPlans: PLANS,
      }
    );
    expect(sent).toHaveLength(0);
  });
});
