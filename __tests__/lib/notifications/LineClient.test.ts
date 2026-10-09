import { describe, expect, it } from "vitest";
import { HTTPFetchError } from "@line/bot-sdk";
import { classifyLineError } from "@/lib/notifications/line/LineClient";
import { isEventTypeEnabledForConnection, type LineConnection } from "@/lib/notifications/db/lineConnections";

function httpError(status: number, headers: Record<string, string> = {}, body = ""): HTTPFetchError {
  return new HTTPFetchError("x", { status, statusText: "x", headers: new Headers(headers), body });
}

describe("LINE 送信結果の分類(受付確認と端末への到達を区別する)", () => {
  it("409 は x-line-accepted-request-id がある場合だけ「受付済み」", () => {
    expect(classifyLineError(httpError(409, { "x-line-accepted-request-id": "abc-123" }))).toEqual({ outcome: "sent", requestId: "abc-123" });
    expect(classifyLineError(httpError(409))).toEqual({ outcome: "unknown", reason: "409_without_accepted_id" });
  });

  it("429: レート制限は待って同じキーで再試行、月間上限は全体を止める", () => {
    expect(classifyLineError(httpError(429, {}, '{"message":"The API rate limit has been exceeded."}'))).toEqual({
      outcome: "retry_wait",
      retryAfterSeconds: 60,
    });
    expect(classifyLineError(httpError(429, {}, '{"message":"You have reached your monthly limit."}'))).toEqual({ outcome: "quota_exceeded" });
  });

  it("その他の 4xx は確定した失敗、5xx・タイムアウト・通信エラーは結果不明", () => {
    expect(classifyLineError(httpError(400))).toEqual({ outcome: "failed", status: 400 });
    expect(classifyLineError(httpError(500))).toEqual({ outcome: "unknown", reason: "http_500" });
    const timeout = new Error("timeout");
    timeout.name = "LineSendTimeout";
    expect(classifyLineError(timeout)).toEqual({ outcome: "unknown", reason: "timeout" });
    expect(classifyLineError(new TypeError("fetch failed"))).toEqual({ outcome: "unknown", reason: "network" });
  });
});

describe("分類できなかった通知でも、スタッフの全通知OFFを迂回しない", () => {
  const base: LineConnection = {
    id: "l1",
    salonId: "s1",
    destinationId: "U1",
    label: null,
    status: "connected",
    newReservationEnabled: false,
    cancellationEnabled: false,
    linkedAt: null,
  };
  it("両方 OFF なら分類できなかった通知も送らない。どちらか ON なら送る", () => {
    expect(isEventTypeEnabledForConnection(base, "unknown")).toBe(false);
    expect(isEventTypeEnabledForConnection({ ...base, cancellationEnabled: true }, "unknown")).toBe(true);
    expect(isEventTypeEnabledForConnection({ ...base, cancellationEnabled: true }, "new_reservation")).toBe(false);
  });
});
