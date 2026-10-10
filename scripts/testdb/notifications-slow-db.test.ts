// 締切の残件の回帰テスト: DB の応答が遅れても、締切を過ぎてから LINE 送信を始めない。
// 再現ケース: 締切45秒・38秒に配信の取り出しを開始し、取り出し9秒・送信直前の確認9秒かかると、
// 以前は56秒で送信を始め、結果・履歴の記録まで77秒かかっていた。
// 時間は仮想の時計、DB は実際のテスト用 DB(配信の DB 操作に遅延・失敗を差し込む)。LINE はモック。
import { afterAll, describe, expect, it } from "vitest";
import { setupNotificationsTestEnv } from "./setupNotificationsEnv";
import { createTestLineConnection, createTestSalon, notificationsTestAdminClient, type TestSalonFixture } from "./notificationsFixtures";
import { connectGoogle, createGoogleTestDeps, uniqueSub } from "./googleFixtures";
import { inbox, virtualClock, type VirtualClock } from "./mailboxFixtures";

setupNotificationsTestEnv();
process.env.NEXT_PUBLIC_APP_MODE = "salonpack";
const admin = notificationsTestAdminClient();
const { pollMailForSalon } = await import("@/lib/notifications/jobs/pollMailForSalon");
const { dbDeliveryStore } = await import("@/lib/notifications/db/notificationDeliveries");
const { customerStartReservationNotifications } = await import("@/lib/notifications/db/operations");
const { createDeadline, CRON_RUN_BUDGET_MS, CRON_HARD_LIMIT_MS } = await import("@/lib/notifications/jobs/runBudget");
const { currentDbTimeLimitMs } = await import("@/lib/notifications/dbTimeLimit");
type Store = import("@/lib/notifications/db/notificationDeliveries").DeliveryStore;
type LineSendOptions = import("@/lib/notifications/line/LineClient").LineSendOptions;
type LineSendResult = import("@/lib/notifications/line/LineClient").LineSendResult;

const SUBS = Array.from({ length: 6 }, () => uniqueSub());
const google = createGoogleTestDeps({ extraUsers: SUBS.map((sub, i) => ({ sub, email: `slowdb-${i}@example.test` })) });
let nextSub = 0;
const salons: TestSalonFixture[] = [];

afterAll(async () => {
  for (const s of salons) await s.cleanup();
  const { data } = await admin.from("google_accounts").select("id").in("google_sub", SUBS);
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length > 0) {
    await admin.from("salon_google_bindings").delete().in("google_account_id", ids);
    await admin.from("google_accounts").delete().in("id", ids);
  }
});

/** LINE のモック(受け付けた retry key を覚え、同じ key は重複させない)。 */
function lineServer(clock: VirtualClock, latencyMs: number) {
  const accepted = new Set<string>();
  const calls: Array<{ retryKey: string; at: number }> = [];
  const send = async (_d: string, _t: string, retryKey: string, options?: LineSendOptions): Promise<LineSendResult> => {
    calls.push({ retryKey, at: clock.now() });
    accepted.add(retryKey);
    const wait = Math.min(latencyMs, options?.timeoutMs ?? latencyMs);
    clock.advance(wait);
    return wait < latencyMs ? { outcome: "unknown", reason: "timeout" } : { outcome: "sent", requestId: `req-${retryKey.slice(0, 8)}` };
  };
  return { send, accepted, calls };
}

/** 稼働中の店舗に、未送信の配信を1件作る(DB に直接)。 */
async function salonWithPendingDelivery() {
  const salon = await createTestSalon();
  salons.push(salon);
  const line = await createTestLineConnection(salon.salonId, { label: "スタッフ" });
  await admin.from("salon_feature_selections").upsert({ salon_id: salon.salonId, feature_key: "reservation_notifications", selected: true }, { onConflict: "salon_id,feature_key" });
  await connectGoogle({ ...google, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: SUBS[nextSub++] });
  expect(await customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: ["salonpack"] })).toBe("started");
  const { data: lc } = await admin.from("line_connections").select("destination_id").eq("id", line).single();
  const { data, error } = await admin
    .from("notification_deliveries")
    .insert({
      salon_id: salon.salonId,
      provider_message_id: `slowdb-${crypto.randomUUID()}`,
      line_connection_id: line,
      destination_id: lc!.destination_id,
      event_type: "new_reservation",
      line_text: "予約",
      mail_received_at: new Date(Date.now() + 1000).toISOString(),
    })
    .select("id, line_retry_key, attempts")
    .single();
  if (error) throw new Error(error.message);
  return { salon, delivery: data as { id: string; line_retry_key: string; attempts: number } };
}

async function row(id: string) {
  const { data } = await admin.from("notification_deliveries").select("*").eq("id", id).single();
  return data as Record<string, unknown>;
}

type AnyFn = (...args: unknown[]) => Promise<unknown>;

/** 応答が遅れて届く(DB では処理済み)。 */
function lateResponse(clock: VirtualClock, fn: AnyFn, delayMs: number): AnyFn {
  return async (...args) => {
    const value = await fn(...args);
    clock.advance(delayMs);
    return value;
  };
}

/** DB では処理されたが、応答は時間の上限で打ち切られた。 */
function abortedAfterCommit(clock: VirtualClock, fn: AnyFn, delayMs: number): AnyFn {
  return async (...args) => {
    const limit = currentDbTimeLimitMs() ?? Infinity;
    const value = await fn(...args);
    if (delayMs > limit) {
      clock.advance(Math.max(0, limit));
      throw new Error("aborted");
    }
    clock.advance(delayMs);
    return value;
  };
}

async function runSalon(salonId: string, clock: VirtualClock, startAtMs: number, store: Store, line: ReturnType<typeof lineServer>, history: unknown[] = []) {
  const started = clock.now();
  const deadline = createDeadline(CRON_RUN_BUDGET_MS, clock.now);
  clock.advance(startAtMs);
  const result = await pollMailForSalon(
    { salonId, accountId: "00000000-0000-0000-0000-000000000000", initialWatermark: new Date(), recipients: [], readMail: false },
    {
      provider: inbox({}),
      scanStore: { acquire: async () => null, progress: async () => true },
      sendLine: line.send,
      allowedPlans: ["salonpack"],
      deadline,
      deliveryStore: store,
      recordHistory: async (entry) => {
        history.push(entry);
      },
    }
  );
  const sendTimes = line.calls.filter((c) => c.at >= started).map((c) => c.at - started);
  return { result, elapsed: clock.now() - started, sendTimes };
}

describe("DB の応答の遅れ: 締切を過ぎてから LINE 送信を始めない", () => {
  it("再現ケース: 38秒に開始し、取り出し・送信直前の確認の応答が9秒ずつ遅れる → LINE を呼ばず、未送信と断定して戻す(上限内)。次の回で1回だけ送る", async () => {
    const { salon, delivery } = await salonWithPendingDelivery();
    const clock = virtualClock(0);
    const line = lineServer(clock, 300);
    const store: Store = {
      ...dbDeliveryStore,
      claim: lateResponse(clock, dbDeliveryStore.claim as AnyFn, 9_000) as Store["claim"],
      begin: lateResponse(clock, dbDeliveryStore.begin as AnyFn, 9_000) as Store["begin"],
    };
    const { elapsed, sendTimes, result } = await runSalon(salon.salonId, clock, 38_000, store, line);
    expect(sendTimes).toEqual([]);
    expect(result.releasedBeforeSend).toBe(1);
    expect(elapsed).toBeLessThanOrEqual(CRON_HARD_LIMIT_MS);
    expect(await row(delivery.id)).toMatchObject({
      status: "pending",
      first_attempt_at: null,
      send_started_at: null,
      claim_token: null,
      attempts: delivery.attempts,
    });

    const next = await runSalon(salon.salonId, clock, 0, dbDeliveryStore, line);
    expect(next.sendTimes).toHaveLength(1);
    expect((await row(delivery.id)).status).toBe("sent");
    expect(line.calls.map((c) => c.retryKey)).toEqual([delivery.line_retry_key]);
  });

  it("取り出しは間に合い、送信直前の確認('send' を記録)の応答が9秒遅れる → LINE を呼ばず、送信開始と最初の送信日時を戻す", async () => {
    const { salon, delivery } = await salonWithPendingDelivery();
    const clock = virtualClock(0);
    const line = lineServer(clock, 300);
    const store: Store = { ...dbDeliveryStore, begin: lateResponse(clock, dbDeliveryStore.begin as AnyFn, 9_000) as Store["begin"] };
    const { elapsed, sendTimes, result } = await runSalon(salon.salonId, clock, 38_000, store, line);
    expect(sendTimes).toEqual([]);
    expect(result.releasedBeforeSend).toBe(1);
    expect(elapsed).toBeLessThanOrEqual(CRON_HARD_LIMIT_MS);
    expect(await row(delivery.id)).toMatchObject({
      status: "pending",
      first_attempt_at: null,
      first_attempt_token: null,
      send_started_at: null,
      attempts: delivery.attempts,
    });
  });

  it("打ち切られた問い合わせ(DB では取り出し済み・応答は時間の上限で打ち切り)→ LINE を呼ばない。処理権の期限のあと元に戻り、次の回で1回だけ送る", async () => {
    const { salon, delivery } = await salonWithPendingDelivery();
    const clock = virtualClock(0);
    const line = lineServer(clock, 300);
    const store: Store = { ...dbDeliveryStore, claim: abortedAfterCommit(clock, dbDeliveryStore.claim as AnyFn, 9_000) as Store["claim"] };
    const { elapsed, sendTimes } = await runSalon(salon.salonId, clock, 38_000, store, line);
    expect(sendTimes).toEqual([]);
    expect(elapsed).toBeLessThanOrEqual(CRON_HARD_LIMIT_MS);
    expect(await row(delivery.id)).toMatchObject({ status: "claimed", send_started_at: null });
    await admin.from("notification_deliveries").update({ claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("id", delivery.id);
    const next = await runSalon(salon.salonId, clock, 0, dbDeliveryStore, line);
    expect(next.sendTimes).toHaveLength(1);
    expect((await row(delivery.id)).status).toBe("sent");
    expect(line.accepted.size).toBe(1);
  });

  it("送信開始の取り消しが失敗したら、未送信とは書き換えない(処理権の期限のあと結果不明 → 同じ retry key で再試行)", async () => {
    const { salon, delivery } = await salonWithPendingDelivery();
    const clock = virtualClock(0);
    const line = lineServer(clock, 300);
    const store: Store = {
      ...dbDeliveryStore,
      begin: lateResponse(clock, dbDeliveryStore.begin as AnyFn, 9_000) as Store["begin"],
      cancelSendStart: async () => {
        throw new Error("db down");
      },
    };
    const first = await runSalon(salon.salonId, clock, 38_000, store, line);
    expect(first.sendTimes).toEqual([]);
    expect(await row(delivery.id)).toMatchObject({ status: "claimed" });
    await admin.from("notification_deliveries").update({ claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("id", delivery.id);
    await runSalon(salon.salonId, clock, 0, dbDeliveryStore, line);
    expect(await row(delivery.id)).toMatchObject({ status: "unknown", last_error: "lease_expired_after_send_start" });
    await admin.from("notification_deliveries").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", delivery.id);
    await runSalon(salon.salonId, clock, 0, dbDeliveryStore, line);
    expect((await row(delivery.id)).status).toBe("sent");
    expect(line.calls.map((c) => c.retryKey)).toEqual([delivery.line_retry_key]);
  });

  it("送信のあとの結果の記録が遅い → 結果は記録し、締切を過ぎた履歴は省く。全体は上限内", async () => {
    const { salon, delivery } = await salonWithPendingDelivery();
    const clock = virtualClock(0);
    const line = lineServer(clock, 1_000);
    const history: unknown[] = [];
    const store: Store = { ...dbDeliveryStore, finish: lateResponse(clock, dbDeliveryStore.finish as AnyFn, 9_000) as Store["finish"] };
    const { elapsed, sendTimes } = await runSalon(salon.salonId, clock, 36_000, store, line, history);
    expect(sendTimes).toHaveLength(1);
    expect(sendTimes[0]).toBeLessThan(CRON_RUN_BUDGET_MS);
    expect((await row(delivery.id)).status).toBe("sent");
    expect(history).toHaveLength(0);
    expect(elapsed).toBeLessThanOrEqual(CRON_HARD_LIMIT_MS);
  });
});
