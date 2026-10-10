import { describe, expect, it } from "vitest";
import {
  callTimeout,
  createDeadline,
  CRON_HARD_LIMIT_MS,
  CRON_RUN_BUDGET_MS,
  GMAIL_MIN_CALL_MS,
  GMAIL_RECORD_MARGIN_MS,
  LINE_MIN_SEND_MS,
  LINE_SEND_TIMEOUT_MS,
  MIN_SALON_SLICE_MS,
  SEND_RECORD_MARGIN_MS,
  SEND_START_MS,
  TOKEN_BUDGET_MS,
} from "@/lib/notifications/jobs/runBudget";
import { resolveFetchStart } from "@/lib/notifications/mail/fetchStart";

describe("締切(runBudget)", () => {
  it("処理の時間が残り時間に収まるときだけ始めてよい", () => {
    let t = 0;
    const deadline = createDeadline(20_000, () => t);
    expect(deadline.allows(SEND_START_MS)).toBe(true);
    t = 15_000;
    expect(deadline.remainingMs()).toBe(5_000);
    expect(deadline.allows(SEND_START_MS)).toBe(false);
    t = 25_000;
    expect(deadline.remainingMs()).toBe(0);
  });

  it("呼び出しのタイムアウトは、記録の時間を残して締切に収まる長さに縮める。下限も収まらなければ始めない", () => {
    let t = 0;
    const deadline = createDeadline(30_000, () => t);
    expect(callTimeout(deadline, LINE_SEND_TIMEOUT_MS, LINE_MIN_SEND_MS, SEND_RECORD_MARGIN_MS)).toBe(LINE_SEND_TIMEOUT_MS);
    t = 22_000; // 残り8秒 → 記録に3秒残して5秒
    expect(callTimeout(deadline, LINE_SEND_TIMEOUT_MS, LINE_MIN_SEND_MS, SEND_RECORD_MARGIN_MS)).toBe(5_000);
    t = 25_500; // 残り4.5秒 → 下限3秒 + 記録3秒が収まらない
    expect(callTimeout(deadline, LINE_SEND_TIMEOUT_MS, LINE_MIN_SEND_MS, SEND_RECORD_MARGIN_MS)).toBeNull();
  });

  it("子の締切は親の締切を越えない(店舗ごとの持ち時間)", () => {
    let t = 0;
    const parent = createDeadline(30_000, () => t);
    const child = parent.child(50_000);
    expect(child.remainingMs()).toBe(30_000);
    const small = parent.child(5_000);
    t = 4_000;
    expect(small.remainingMs()).toBe(1_000);
    expect(parent.remainingMs()).toBe(26_000);
  });

  it("締切は関数の上限(60秒)の内側。締切の直前に始めた最長の処理(トークンの取得)も上限までに終わる", () => {
    expect(CRON_RUN_BUDGET_MS + TOKEN_BUDGET_MS).toBeLessThanOrEqual(60_000);
    expect(CRON_RUN_BUDGET_MS).toBeLessThan(CRON_HARD_LIMIT_MS);
    expect(CRON_HARD_LIMIT_MS).toBeLessThan(60_000);
    expect(MIN_SALON_SLICE_MS).toBeGreaterThanOrEqual(TOKEN_BUDGET_MS);
    // 最小の持ち時間でも、段階1(Gmail)に最短の呼び出しと記録の時間、段階2(配信)に1件分の時間が残る
    // (pollMailForSalon の段階1は min(残り/2, 残り − SEND_START_MS))。
    const stage1 = Math.min(MIN_SALON_SLICE_MS / 2, MIN_SALON_SLICE_MS - SEND_START_MS);
    expect(stage1).toBeGreaterThanOrEqual(GMAIL_MIN_CALL_MS + GMAIL_RECORD_MARGIN_MS);
    expect(MIN_SALON_SLICE_MS - stage1).toBeGreaterThanOrEqual(SEND_START_MS);
  });

  it("上限は締切より後(始めていた処理の記録・後片付けに使う)。子の締切も同じ上限を持つ", () => {
    let t = 0;
    const deadline = createDeadline(CRON_RUN_BUDGET_MS, () => t);
    const child = deadline.child(1_000);
    t = CRON_RUN_BUDGET_MS + 1_000;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.hardRemainingMs()).toBe(CRON_HARD_LIMIT_MS - CRON_RUN_BUDGET_MS - 1_000);
    expect(child.hardRemainingMs()).toBe(deadline.hardRemainingMs());
  });
});

describe("メール取得開始日時(接続日時で切り詰めない)", () => {
  const at = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00+09:00`);

  it("旧サービスからの切り替え: 9時から取得・10時に接続 → 9時から読む(9時30分の未処理メールを取り込む)", () => {
    const result = resolveFetchStart({
      mailFetchSince: at("09:00"),
      mailFetchAccountId: "acc-1",
      currentAccountId: "acc-1",
      accountBoundAt: at("10:00"),
    });
    expect(result).toEqual({ since: at("09:00"), reason: "configured" });
  });

  it("新規店舗の初回開始: 開始した日時から(接続した日時ではない)", () => {
    // 10時に接続、11時に開始(mail_fetch_since = 開始日時)。
    const result = resolveFetchStart({
      mailFetchSince: at("11:00"),
      mailFetchAccountId: "acc-1",
      currentAccountId: "acc-1",
      accountBoundAt: at("10:00"),
    });
    expect(result.since).toEqual(at("11:00"));
  });

  it("同じアカウントの再認証: 取得開始は変えない(結び付けた日時は再認証では変わらない)", () => {
    const result = resolveFetchStart({
      mailFetchSince: at("09:00"),
      mailFetchAccountId: "acc-1",
      currentAccountId: "acc-1",
      accountBoundAt: at("08:00"),
    });
    expect(result).toEqual({ since: at("09:00"), reason: "configured" });
  });

  it("開始後に別のアカウントへ切り替えた: 新しい受信箱の、切り替える前のメールは読まない", () => {
    const result = resolveFetchStart({
      mailFetchSince: at("09:00"),
      mailFetchAccountId: "acc-1",
      currentAccountId: "acc-2",
      accountBoundAt: at("12:00"),
    });
    expect(result).toEqual({ since: at("12:00"), reason: "account_switched_after_start" });
  });
});
