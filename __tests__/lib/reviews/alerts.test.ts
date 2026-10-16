import { describe, expect, it, vi } from "vitest";
import { buildReviewAlertMessage, reviewAlertAltText, reviewAlertTestText } from "@/lib/reviews/alerts/message";
import { deliverReviewAlerts, evaluateReviewAlerts, type DeliverDeps } from "@/lib/reviews/alerts/deliver";
import { quotaAllowsReviewAlerts, quotaReservePercent } from "@/lib/reviews/alerts/lineQuota";
import { parseAlertMessage, type AlertBeginSend, type ClaimedAlertDelivery } from "@/lib/reviews/alerts/store";
import { createDeadline } from "@/lib/notifications/jobs/runBudget";
import { LineSendBlockedError, type LineSendResult } from "@/lib/notifications/line/LineClient";

vi.mock("server-only", () => ({}));

const data = { salonName: "架空サロン 渋谷店", url: "https://salonpack.example.test/dashboard/reviews/google/0b6f8a52-1111-4222-8333-944455556666" };

describe("口コミの LINE 通知の文面", () => {
  it("店舗名・新しい口コミが届いたこと・確認ボタンだけ。口コミの内容・評価・投稿者名・件数は入らない", () => {
    const m = buildReviewAlertMessage(data);
    expect(m.altText).toBe("【SalonPack】架空サロン 渋谷店 新しい口コミが届きました。");
    const json = JSON.stringify(m);
    expect(json).toContain("【SalonPack】架空サロン 渋谷店");
    expect(json).toContain("新しい口コミが届きました。");
    expect(json).toContain("口コミを確認する");
    expect(json).toContain(data.url);
    expect(json).not.toMatch(/★|評価|件|投稿者|返信/);
    // 送る内容は data(店舗名と URL)だけから作られ、同じ data なら同じ内容(再試行で内容が変わらない)
    expect(buildReviewAlertMessage({ ...data })).toEqual(m);
  });

  it("低評価・本文なしなどの区別は無い(入力に評価・本文を持たない)", () => {
    expect(Object.keys(parseAlertMessage({ salon_name: "A", url: "https://x.test/a", star: 1, comment: "x" })!)).toEqual(["salonName", "url"]);
  });

  it("店舗名が空なら「ご登録の店舗」。テスト通知はボタンなしの文", () => {
    expect(reviewAlertAltText({ salonName: "  ", url: data.url })).toBe("【SalonPack】ご登録の店舗 新しい口コミが届きました。");
    expect(reviewAlertTestText("架空サロン")).toBe("【SalonPack】架空サロン\n口コミのLINE通知のテストです。");
  });
});

describe("月の送信数の取り置き", () => {
  it("上限の残りが取り置きの割合以下なら止める。上限の無いプランは止めない", () => {
    expect(quotaAllowsReviewAlerts({ limit: 5000, used: 4400 }, 10)).toBe(true);
    expect(quotaAllowsReviewAlerts({ limit: 5000, used: 4500 }, 10)).toBe(false);
    expect(quotaAllowsReviewAlerts({ limit: null, used: 999999 }, 10)).toBe(true);
    expect(quotaReservePercent({})).toBe(10);
    expect(quotaReservePercent({ REVIEW_ALERT_LINE_QUOTA_RESERVE: "20" })).toBe(20);
    expect(quotaReservePercent({ REVIEW_ALERT_LINE_QUOTA_RESERVE: "abc" })).toBe(10);
  });
});

function fakeStore(begins: AlertBeginSend[]) {
  const queue = begins.map((b, i) => ({ delivery: { id: `d${i}`, claimToken: `t${i}`, salonId: "s", lineConnectionId: `l${i}` }, begin: b }));
  const finished: { id: string; outcome: string; error?: string | null; retryAfterSeconds?: number | null; lineRequestId?: string | null }[] = [];
  const released: string[] = [];
  const cancelled: string[] = [];
  let claimed = 0;
  const store: DeliverDeps["store"] = {
    claim: async () => queue[claimed]?.delivery ?? null,
    beginSend: async (d: ClaimedAlertDelivery) => {
      const item = queue.find((q) => q.delivery.id === d.id)!;
      claimed++;
      return item.begin;
    },
    finish: async ({ delivery, outcome, error, retryAfterSeconds, lineRequestId }) => {
      finished.push({ id: delivery.id, outcome, error, retryAfterSeconds, lineRequestId });
      return true;
    },
    releaseClaim: async (d) => {
      released.push(d.id);
      claimed++;
      return true;
    },
    cancelSendStart: async (d) => {
      cancelled.push(d.id);
      return true;
    },
  };
  return { store, finished, released, cancelled };
}

const send = (destinationId = "U0", retryKey = "k"): AlertBeginSend => ({ decision: "send", destinationId, message: data, retryKey });

describe("配信", () => {
  it("送信の結果を記録する(200・409 は送信済み、5xx・タイムアウトは結果不明、429 は再試行待ち、4xx は失敗)", async () => {
    const f = fakeStore([send("U1", "k1"), send("U2", "k2"), send("U3", "k3"), send("U4", "k4"), { decision: "skipped", reason: "alerts_off" }]);
    const results: LineSendResult[] = [
      { outcome: "sent", requestId: "req-1" },
      { outcome: "unknown", reason: "timeout" },
      { outcome: "retry_wait", retryAfterSeconds: 60 },
      { outcome: "failed", status: 400 },
    ];
    const calls: { dest: string; key: string; message: unknown }[] = [];
    const summary = await deliverReviewAlerts({
      store: f.store,
      send: async (dest, message, key) => {
        calls.push({ dest, key, message });
        return results.shift()!;
      },
      consentVersion: "v",
      deadline: createDeadline(45_000),
    });
    expect(summary).toMatchObject({ sent: 1, unknown: 1, retryWait: 1, failed: 1, skipped: 1 });
    expect(f.finished.map((x) => [x.id, x.outcome])).toEqual([
      ["d0", "sent"],
      ["d1", "unknown"],
      ["d2", "retry_wait"],
      ["d3", "failed"],
    ]);
    expect(f.finished[0].lineRequestId).toBe("req-1");
    expect(calls.map((c) => [c.dest, c.key])).toEqual([["U1", "k1"], ["U2", "k2"], ["U3", "k3"], ["U4", "k4"]]);
    expect(calls.every((c) => c.message === data)).toBe(true);
  });

  it("月間の上限(429)なら、この回の送信をやめて1時間後に再試行する", async () => {
    const f = fakeStore([send(), send()]);
    const summary = await deliverReviewAlerts({
      store: f.store,
      send: async () => ({ outcome: "quota_exceeded" }),
      consentVersion: "v",
      deadline: createDeadline(45_000),
    });
    expect(summary.quotaExceeded).toBe(true);
    expect(f.finished).toEqual([{ id: "d0", outcome: "retry_wait", error: "monthly_limit", retryAfterSeconds: 3600, lineRequestId: undefined }]);
  });

  it("この環境では送らない(LineSendBlockedError)なら、送信の開始を取り消して止める(HTTP は呼んでいない)", async () => {
    const f = fakeStore([send(), send()]);
    const summary = await deliverReviewAlerts({
      store: f.store,
      send: async () => {
        throw new LineSendBlockedError();
      },
      consentVersion: "v",
      deadline: createDeadline(45_000),
    });
    expect(summary.blocked).toBe(1);
    expect(f.cancelled).toEqual(["d0"]);
    expect(f.finished).toEqual([]);
  });

  it("想定外の例外は結果不明として記録する(送ったかどうか分からない)", async () => {
    const f = fakeStore([send()]);
    await deliverReviewAlerts({
      store: f.store,
      send: async () => {
        throw new Error("boom");
      },
      consentVersion: "v",
      deadline: createDeadline(45_000),
    });
    expect(f.finished).toEqual([{ id: "d0", outcome: "unknown", error: "client_error", retryAfterSeconds: undefined, lineRequestId: undefined }]);
  });

  it("月の残りが少ないときは、取り出した配信を戻して送らない", async () => {
    const f = fakeStore([send()]);
    const sender = vi.fn();
    const summary = await deliverReviewAlerts({ store: f.store, send: sender, consentVersion: "v", deadline: createDeadline(45_000), quotaAllows: async () => false });
    expect(summary.quotaReserved).toBe(true);
    expect(f.released).toEqual(["d0"]);
    expect(sender).not.toHaveBeenCalled();
  });

  it("締切が近ければ取り出さない", async () => {
    let t = 0;
    const deadline = createDeadline(1_000, () => t);
    t = 900;
    const f = fakeStore([send()]);
    const sender = vi.fn();
    await deliverReviewAlerts({ store: f.store, send: sender, consentVersion: "v", deadline });
    expect(sender).not.toHaveBeenCalled();
  });
});

describe("評価", () => {
  it("待っているイベントを評価して数える", async () => {
    const evaluate = vi.fn(async (id: string) => (id === "e1" ? "notify" : "skipped:alerts_off"));
    const s = await evaluateReviewAlerts({
      store: { pendingEvents: async () => [{ id: "e1", salonId: "s" }, { id: "e2", salonId: "s" }], evaluate },
      baseUrl: "https://salonpack.example.test",
      consentVersion: "v",
      deadline: createDeadline(45_000),
    });
    expect(s).toEqual({ evaluated: 2, notify: 1, skipped: 1, deferred: 0 });
    expect(evaluate).toHaveBeenCalledWith("e1", "https://salonpack.example.test", "v");
  });
});
