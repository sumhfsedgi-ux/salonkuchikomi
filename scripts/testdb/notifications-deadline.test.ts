// 定期処理の実行時間の管理(締切までに新しい処理を始めない・途中で止めても失敗にしない・後ろの店舗を
// 取り残さない・強制終了のあとも同じ retry key で再開する)の testdb テスト。
// 時間は仮想の時計で進める(Gmail・LINE の呼び出しごとに「かかった時間」を進める)。DB は実際のテスト用 DB。
// Google は擬似、Gmail・LINE はモック(本物には接続しない)。
import { afterAll, describe, expect, it } from "vitest";
import { setupNotificationsTestEnv } from "./setupNotificationsEnv";
import { createTestLineConnection, createTestSalon, notificationsTestAdminClient, type TestSalonFixture } from "./notificationsFixtures";
import { connectGoogle, createGoogleTestDeps, uniqueSub } from "./googleFixtures";
import { inbox, providersBySalon, reservationMail, virtualClock, type InboxOptions, type TestInbox, type TestMail, type VirtualClock } from "./mailboxFixtures";

setupNotificationsTestEnv();
process.env.NEXT_PUBLIC_APP_MODE = "salonpack";
const admin = notificationsTestAdminClient();
const { pollMailForAllSalons } = await import("@/lib/notifications/jobs/pollMailForAllSalons");
const { customerStartReservationNotifications } = await import("@/lib/notifications/db/operations");
const { createDeadline, CRON_RUN_BUDGET_MS } = await import("@/lib/notifications/jobs/runBudget");
type LineSendOptions = import("@/lib/notifications/line/LineClient").LineSendOptions;
type LineSendResult = import("@/lib/notifications/line/LineClient").LineSendResult;

const SUBS = Array.from({ length: 12 }, () => uniqueSub());
const google = createGoogleTestDeps({ extraUsers: SUBS.map((sub, i) => ({ sub, email: `deadline-${i}@example.test` })) });
let nextSub = 0;
const salons: TestSalonFixture[] = [];

/** LINE のモック。受け付けた retry key を覚え、同じ key の再送は重複させない(409 + 受付済みID と同じ扱い)。 */
function lineServer(clock: VirtualClock, latencyMs: number) {
  const accepted = new Map<string, { destination: string; text: string }>();
  const calls: Array<{ destination: string; retryKey: string; outcome: string }> = [];
  const send = async (destination: string, text: string, retryKey: string, options?: LineSendOptions): Promise<LineSendResult> => {
    const duplicate = accepted.has(retryKey);
    if (!duplicate) accepted.set(retryKey, { destination, text }); // 応答を待ちきれなくても、LINE 側では受け付けている場合がある
    if (options?.timeoutMs !== undefined && latencyMs > options.timeoutMs) {
      clock.advance(options.timeoutMs);
      calls.push({ destination, retryKey, outcome: "unknown" });
      return { outcome: "unknown", reason: "timeout" };
    }
    clock.advance(latencyMs);
    calls.push({ destination, retryKey, outcome: "sent" });
    return { outcome: "sent", requestId: duplicate ? `accepted-${retryKey.slice(0, 8)}` : `req-${retryKey.slice(0, 8)}` };
  };
  return { send, accepted, calls };
}

async function startSalon(staff: number) {
  const salon = await createTestSalon();
  salons.push(salon);
  const lines: string[] = [];
  for (let i = 0; i < staff; i++) lines.push(await createTestLineConnection(salon.salonId, { label: `スタッフ${i}` }));
  await admin.from("salon_feature_selections").upsert({ salon_id: salon.salonId, feature_key: "reservation_notifications", selected: true }, { onConflict: "salon_id,feature_key" });
  const { result } = await connectGoogle({ ...google, salonId: salon.salonId, userId: salon.userId, features: ["gmail"], sub: SUBS[nextSub++] });
  expect(result.status).toBe("connected");
  expect(await customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: ["salonpack"] })).toBe("started");
  return { salon, lines };
}

function mailsAfterStart(start: Date, count: number, prefix: string): Record<string, TestMail> {
  const mails: Record<string, TestMail> = {};
  for (let i = 0; i < count; i++) mails[`${prefix}-${i}`] = reservationMail(new Date(start.getTime() + 1000 + i * 1000), `${prefix}-${i}`);
  return mails;
}

async function deliveriesOf(salonId: string) {
  const { data } = await admin.from("notification_deliveries").select("id, provider_message_id, line_connection_id, status, line_retry_key, attempts").eq("salon_id", salonId);
  return data ?? [];
}

async function processedOf(salonId: string) {
  const { data } = await admin.from("processed_emails").select("provider_message_id, event_type, classify_attempts").eq("salon_id", salonId);
  return data ?? [];
}

async function activatedAt(salonId: string) {
  const { data } = await admin.from("reservation_notification_operations").select("mail_fetch_since").eq("salon_id", salonId).single();
  return new Date(data!.mail_fetch_since as string);
}

async function pauseAll(ids: string[]) {
  for (const id of ids) await admin.rpc("reservation_ops_pause", { p_salon_id: id, p_by: "test", p_reason: "scenario_done", p_kind: "operator_pause" });
}

async function run(params: {
  clock: VirtualClock;
  boxes: Map<string, TestInbox>;
  line: ReturnType<typeof lineServer>;
  budgetMs?: number;
}) {
  const startedAt = params.clock.now();
  const summary = await pollMailForAllSalons({
    transport: google.sim.transport,
    config: google.deps.config,
    sendLine: params.line.send,
    createProvider: providersBySalon(params.boxes),
    deadline: createDeadline(params.budgetMs ?? CRON_RUN_BUDGET_MS, params.clock.now),
  });
  return { summary, elapsed: params.clock.now() - startedAt };
}

afterAll(async () => {
  for (const s of salons) await s.cleanup();
  const { data } = await admin.from("google_accounts").select("id").in("google_sub", SUBS);
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length > 0) {
    await admin.from("salon_google_bindings").delete().in("google_account_id", ids);
    await admin.from("google_accounts").delete().in("id", ids);
  }
});

describe("大量の未処理メールと遅い Gmail", () => {
  it("1回の処理は締切までに終わり、先にまとめてクレームしない。残りは失敗にせず次の回へ回し、最後には全員に1回ずつ届く", async () => {
    const { salon, lines } = await startSalon(2);
    const clock = virtualClock();
    const mails = mailsAfterStart(await activatedAt(salon.salonId), 20, "bulk");
    const box = inbox(mails, { clock, listLatencyMs: 500, getLatencyMs: 2_000 });
    const line = lineServer(clock, 300);
    const boxes = new Map([[salon.salonId, box]]);

    const first = await run({ clock, boxes, line });
    expect(first.elapsed).toBeLessThanOrEqual(CRON_RUN_BUDGET_MS);
    const result = first.summary.results.find((r) => r.salonId === salon.salonId)!.result!;
    expect(result.stoppedForTime).toBe(true);
    const processed1 = await processedOf(salon.salonId);
    expect(processed1.length).toBeGreaterThan(0);
    expect(processed1.length).toBeLessThan(20);
    expect(processed1.every((p) => p.event_type !== "pending")).toBe(true); // 手を付けられないメールをクレームしていない
    const d1 = await deliveriesOf(salon.salonId);
    expect(d1.every((d) => ["sent", "pending"].includes(d.status as string))).toBe(true); // 未着手の配信は失敗にしない

    for (let i = 0; i < 10; i++) {
      const next = await run({ clock, boxes, line });
      expect(next.elapsed).toBeLessThanOrEqual(CRON_RUN_BUDGET_MS);
      const all = await deliveriesOf(salon.salonId);
      if (all.length === 40 && all.every((d) => d.status === "sent")) break;
    }
    const final = await deliveriesOf(salon.salonId);
    expect(final).toHaveLength(40);
    expect(final.every((d) => d.status === "sent")).toBe(true);
    // LINE 側で受け付けたのは配信1件につき1回(同じ配信は同じ retry key)。
    expect(line.accepted.size).toBe(40);
    expect(new Set(final.map((d) => d.line_retry_key)).size).toBe(40);
    for (const d of final) expect(line.accepted.has(d.line_retry_key as string)).toBe(true);
    expect(new Set([...line.accepted.values()].map((v) => v.destination)).size).toBe(lines.length);
    // 途中で止めたことを失敗(分類の再試行)として数えていない。
    expect((await processedOf(salon.salonId)).every((p) => p.classify_attempts === 1)).toBe(true);
    await pauseAll([salon.salonId]);
  });

  it("締切に合わせて縮めたタイムアウトで本文の取得を打ち切ったメールは、失敗として数えずに次の回で処理する", async () => {
    const { salon } = await startSalon(1);
    const clock = virtualClock();
    const mails = mailsAfterStart(await activatedAt(salon.salonId), 1, "slow");
    // 一覧は0.5秒、本文は6秒かかる。13秒の持ち時間では、本文の取得に使える時間が足りない。
    const box = inbox(mails, { clock, listLatencyMs: 500, getLatencyMs: 6_000 });
    const line = lineServer(clock, 300);
    const boxes = new Map([[salon.salonId, box]]);

    await run({ clock, boxes, line, budgetMs: 13_000 });
    expect(box.calls.some((c) => c.op === "get" && (c.timeoutMs ?? 0) < 6_000)).toBe(true);
    const [p1] = await processedOf(salon.salonId);
    expect(p1).toMatchObject({ event_type: "pending", classify_attempts: 0 }); // 打ち切りは試行回数に数えない
    expect(line.calls).toHaveLength(0);

    await run({ clock, boxes, line });
    const [p2] = await processedOf(salon.salonId);
    expect(p2).toMatchObject({ event_type: "new_reservation", classify_attempts: 1 });
    expect(line.accepted.size).toBe(1);
    await pauseAll([salon.salonId]);
  });
});

describe("複数の店舗", () => {
  it("1つの店舗に大量の未処理メールがあっても、後ろの店舗の予約は同じ回に届く", async () => {
    const heavy = await startSalon(1);
    const light1 = await startSalon(1);
    const light2 = await startSalon(1);
    const clock = virtualClock();
    const boxes = new Map<string, TestInbox>();
    const slow: InboxOptions = { clock, listLatencyMs: 500, getLatencyMs: 3_000 };
    boxes.set(heavy.salon.salonId, inbox(mailsAfterStart(await activatedAt(heavy.salon.salonId), 30, "heavy"), slow));
    boxes.set(light1.salon.salonId, inbox(mailsAfterStart(await activatedAt(light1.salon.salonId), 1, "light1"), slow));
    boxes.set(light2.salon.salonId, inbox(mailsAfterStart(await activatedAt(light2.salon.salonId), 1, "light2"), slow));
    // 大量の未処理がある店舗を先頭にする(最後に処理した日時が最も古い)。
    for (const [i, s] of [heavy, light1, light2].entries()) {
      await admin.from("gmail_scan_state").upsert(
        { salon_id: s.salon.salonId, watermark: (await activatedAt(s.salon.salonId)).toISOString(), last_tick_at: new Date(Date.now() - (10 - i) * 60_000).toISOString() },
        { onConflict: "salon_id" }
      );
    }
    const line = lineServer(clock, 300);
    const { elapsed } = await run({ clock, boxes, line });
    expect(elapsed).toBeLessThanOrEqual(CRON_RUN_BUDGET_MS);
    for (const s of [light1, light2]) {
      const d = await deliveriesOf(s.salon.salonId);
      expect(d.map((x) => x.status)).toEqual(["sent"]);
    }
    expect((await processedOf(heavy.salon.salonId)).length).toBeLessThan(30); // 大量の店舗は持ち時間の分だけ
    await pauseAll([heavy, light1, light2].map((s) => s.salon.salonId));
  });

  it("時間が足りずに後回しにした店舗は、失敗にせず、次の回の最初に処理する", async () => {
    const a = await startSalon(1);
    const b = await startSalon(1);
    const c = await startSalon(1);
    const clock = virtualClock();
    const slow: InboxOptions = { clock, listLatencyMs: 500, getLatencyMs: 2_000 };
    const boxes = new Map<string, TestInbox>();
    boxes.set(a.salon.salonId, inbox(mailsAfterStart(await activatedAt(a.salon.salonId), 20, "a"), slow));
    boxes.set(b.salon.salonId, inbox(mailsAfterStart(await activatedAt(b.salon.salonId), 1, "b"), slow));
    boxes.set(c.salon.salonId, inbox(mailsAfterStart(await activatedAt(c.salon.salonId), 1, "c"), slow));
    for (const [i, s] of [a, b, c].entries()) {
      await admin.from("gmail_scan_state").upsert(
        { salon_id: s.salon.salonId, watermark: (await activatedAt(s.salon.salonId)).toISOString(), last_tick_at: new Date(Date.now() - (10 - i) * 60_000).toISOString() },
        { onConflict: "salon_id" }
      );
    }
    const line = lineServer(clock, 300);
    // 16秒: 先頭の2店舗(それぞれ一覧0.5秒 + 本文2秒 + 送信0.3秒)のあと、3店舗目に必要な最低限の時間(12秒)が残らない。
    const first = await run({ clock, boxes, line, budgetMs: 16_000 });
    expect(first.summary.salonsDeferred).toBe(1);
    expect(first.summary.salonsFailed).toBe(0);
    expect(await deliveriesOf(c.salon.salonId)).toHaveLength(0);
    const { data: cronRow } = await admin.from("cron_runs").select("notes").order("started_at", { ascending: false }).limit(1).single();
    expect(cronRow?.notes ?? "").toContain("deferred_for_time:1");

    // 次の回: 後回しにした店舗(最後に処理を始めた日時が最も古い)から処理する。
    const second = await run({ clock, boxes, line, budgetMs: 16_000 });
    expect(second.summary.results[0].salonId).toBe(c.salon.salonId);
    expect((await deliveriesOf(c.salon.salonId)).map((d) => d.status)).toEqual(["sent"]);
    await pauseAll([a, b, c].map((s) => s.salon.salonId));
  });
});

describe("実時間(仮想の時計ではなく実際の待ち時間)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** 実際に待つ。タイムアウトより遅ければ、タイムアウトの分だけ待って timeout にする。 */
  async function wait(ms: number, timeoutMs: number | undefined) {
    if (timeoutMs !== undefined && ms > timeoutMs) {
      await sleep(timeoutMs);
      throw new (await import("@/lib/notifications/mail/MailProvider")).MailProviderError("timeout");
    }
    await sleep(ms);
  }

  it("遅い Gmail(本文1.5秒)・遅い LINE(0.5秒)でも、締切の内側で戻る。残りは未処理のまま次の回へ", async () => {
    const { salon } = await startSalon(2);
    const base = inbox(mailsAfterStart(await activatedAt(salon.salonId), 10, "real"));
    const slowInbox: TestInbox = {
      calls: base.calls,
      async listPage(q, t, s, o) {
        await wait(300, o?.timeoutMs);
        return base.listPage(q, t, s, o);
      },
      async getMessage(id, o) {
        await wait(1_500, o?.timeoutMs);
        return base.getMessage(id, o);
      },
    };
    const sent: string[] = [];
    const budgetMs = 25_000;
    const startedAt = Date.now();
    await pollMailForAllSalons({
      transport: google.sim.transport,
      config: google.deps.config,
      sendLine: async (_d, _t, retryKey, options) => {
        if (options?.timeoutMs !== undefined && 500 > options.timeoutMs) {
          await sleep(options.timeoutMs);
          return { outcome: "unknown", reason: "timeout" };
        }
        await sleep(500);
        sent.push(retryKey);
        return { outcome: "sent", requestId: `real-${sent.length}` };
      },
      createProvider: providersBySalon(new Map([[salon.salonId, slowInbox]])),
      deadline: createDeadline(budgetMs),
    });
    const elapsed = Date.now() - startedAt;
    // 締切のあとに行うのは、始めていた処理の結果の記録と、定期処理の記録だけ。
    expect(elapsed).toBeLessThan(budgetMs + 2_500);
    expect(sent.length).toBeGreaterThan(0);
    const d = await deliveriesOf(salon.salonId);
    expect(d.some((x) => ["failed", "claimed"].includes(x.status as string))).toBe(false);
    expect((await processedOf(salon.salonId)).every((p) => p.event_type !== "pending" || p.classify_attempts === 0)).toBe(true);
    await pauseAll([salon.salonId]);
  });
});

describe("途中終了と再開", () => {
  it("LINE への送信を始めた直後に強制終了しても、再開後は同じ retry key で送り直し、重複しない", async () => {
    const { salon } = await startSalon(1);
    const clock = virtualClock();
    const boxes = new Map([[salon.salonId, inbox(mailsAfterStart(await activatedAt(salon.salonId), 1, "kill"))]]);
    const line = lineServer(clock, 300);

    // 1回目: 送信を始めたところで関数が強制終了した(応答が返らず、結果も記録されない)。
    let firstKey: string | null = null;
    const killed = pollMailForAllSalons({
      transport: google.sim.transport,
      config: google.deps.config,
      sendLine: async (destination, text, retryKey, options) => {
        firstKey = retryKey;
        await line.send(destination, text, retryKey, options); // LINE 側では受け付けている
        return new Promise<LineSendResult>(() => {}); // 応答を受け取る前に終了
      },
      createProvider: providersBySalon(boxes),
      deadline: createDeadline(CRON_RUN_BUDGET_MS, clock.now),
    });
    void killed;
    for (let i = 0; i < 200 && !firstKey; i++) await new Promise((r) => setTimeout(r, 50));
    expect(firstKey).toBeTruthy();
    const [d0] = await deliveriesOf(salon.salonId);
    expect(d0.status).toBe("claimed");

    // 処理権の期限が切れる(強制終了した処理は戻ってこない)。
    await admin.from("notification_deliveries").update({ claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq("id", d0.id);
    await run({ clock, boxes, line });
    const [d1] = await deliveriesOf(salon.salonId);
    expect(d1.status).toBe("unknown"); // 未送信には戻さない(送った可能性がある)
    expect(line.calls).toHaveLength(1); // すぐには送り直さない

    await admin.from("notification_deliveries").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", d0.id);
    await run({ clock, boxes, line });
    const [d2] = await deliveriesOf(salon.salonId);
    expect(d2.status).toBe("sent");
    expect(line.calls.map((c) => c.retryKey)).toEqual([firstKey, firstKey]);
    expect(line.accepted.size).toBe(1); // LINE 側で受け付けたのは1回だけ
    await pauseAll([salon.salonId]);
  });

  it("LINE の応答が遅い: 締切までに送れない配信は取り出さず(未送信のまま)、応答待ちを締切で打ち切ったものは同じ retry key で後から送る", async () => {
    const { salon } = await startSalon(3);
    const clock = virtualClock();
    const boxes = new Map([[salon.salonId, inbox(mailsAfterStart(await activatedAt(salon.salonId), 5, "slowline"), { clock, listLatencyMs: 200, getLatencyMs: 200 })]]);
    const line = lineServer(clock, 4_000);

    const first = await run({ clock, boxes, line });
    expect(first.elapsed).toBeLessThanOrEqual(CRON_RUN_BUDGET_MS);
    const d1 = await deliveriesOf(salon.salonId);
    expect(d1).toHaveLength(15);
    expect(d1.some((d) => d.status === "pending")).toBe(true);
    expect(d1.some((d) => ["failed", "claimed"].includes(d.status as string))).toBe(false);

    for (let i = 0; i < 10; i++) {
      await admin.from("notification_deliveries").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("salon_id", salon.salonId).in("status", ["unknown", "retry_wait"]);
      const next = await run({ clock, boxes, line });
      expect(next.elapsed).toBeLessThanOrEqual(CRON_RUN_BUDGET_MS);
      if ((await deliveriesOf(salon.salonId)).every((d) => d.status === "sent")) break;
    }
    const final = await deliveriesOf(salon.salonId);
    expect(final.every((d) => d.status === "sent")).toBe(true);
    expect(line.accepted.size).toBe(15);
    // 結果不明になった配信の再送は、すべて最初と同じ retry key。
    for (const d of final) {
      const keys = line.calls.filter((c) => c.retryKey === d.line_retry_key);
      expect(keys.length).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(line.calls.map((c) => c.retryKey)).size).toBe(15);
    await pauseAll([salon.salonId]);
  });
});
