import { describe, expect, it } from "vitest";
import { scanCandidates, type ScanLease, type ScanStore } from "@/lib/notifications/mail/gmailScan";
import { MailProviderError, type MailProvider } from "@/lib/notifications/mail/MailProvider";

// Gmail の読み進め(続きからの再開・取りこぼし防止)の単体テスト。DB の代わりにメモリ上の保存先を使う。
// 同時実行(リース)は scripts/testdb の実 Postgres で確かめる。

interface Stored {
  watermark: Date;
  scanId: string | null;
  scanStartedAt: Date | null;
  pageToken: string | null;
  leased: boolean;
}

function memoryStore(initial: Partial<Stored> = {}): ScanStore & { state: Stored } {
  const state: Stored = { watermark: new Date("2026-10-01T00:00:00Z"), scanId: null, scanStartedAt: null, pageToken: null, leased: false, ...initial };
  return {
    state,
    async acquire({ initialWatermark }) {
      if (state.leased) return null;
      state.leased = true;
      if (state.watermark < initialWatermark) state.watermark = initialWatermark;
      const lease: ScanLease = { leaseToken: "lease", watermark: state.watermark, scanId: state.scanId, scanStartedAt: state.scanStartedAt, pageToken: state.pageToken };
      return lease;
    },
    async progress(p) {
      state.scanId = p.scanId;
      state.scanStartedAt = p.scanStartedAt;
      state.pageToken = p.pageToken;
      if (p.completed && p.completedWatermark && p.completedWatermark > state.watermark) state.watermark = p.completedWatermark;
      if (p.release) state.leased = false;
      return true;
    },
  };
}

/** 新しい順の受信箱。page token は "p<index>"。 */
function inbox(ids: string[], pageSize: number, options: { failToken?: string } = {}): MailProvider & { calls: Array<{ query: string; token: string | null }> } {
  const calls: Array<{ query: string; token: string | null }> = [];
  return {
    calls,
    async listPage(query, token) {
      calls.push({ query, token });
      if (options.failToken && token === options.failToken) throw new MailProviderError("invalid_page_token");
      const start = token ? Number(token.slice(1)) : 0;
      const slice = ids.slice(start, start + pageSize);
      const next = start + pageSize < ids.length ? `p${start + pageSize}` : null;
      return { ids: slice, nextPageToken: next };
    },
    async getMessage() {
      throw new Error("not used");
    },
  };
}

const NOW = new Date("2026-10-08T00:00:00Z");

describe("scanCandidates", () => {
  it("ページ数の上限で打ち切っても続きを保存し、次回はそこから再開して最後まで読む", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`);
    const provider = inbox(ids, 5);
    const store = memoryStore();
    const seen: string[] = [];
    const run = () =>
      scanCandidates({
        salonId: "s",
        accountId: "a",
        initialWatermark: new Date("2026-10-01T00:00:00Z"),
        provider,
        store,
        onPageIds: async (page) => {
          seen.push(...page);
          return true;
        },
        now: () => NOW,
        pageSize: 5,
        maxBacklogPages: 2,
      });

    const first = await run();
    expect(first.completedScan).toBe(false);
    expect(store.state.pageToken).toBe("p10");
    await run();
    const third = await run();
    expect(third.completedScan).toBe(true);
    // 25件すべてを少なくとも1回は読んでいる(先頭ページは毎回読むため重複はあるが、取りこぼしは無い)。
    expect(new Set(seen)).toEqual(new Set(ids));
    // 読み切ったときだけ基準日時を進める(開始日時の1日前)。
    expect(store.state.watermark.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(store.state.leased).toBe(false);
  });

  it("処理済みのメールが先頭に並んでいても(上限を超える件数でも)、古い未処理のメールまで届く", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${i}`);
    const processed = new Set(ids.slice(0, 25)); // 新しい25件は処理済み
    const provider = inbox(ids, 5);
    const store = memoryStore();
    const newlyClaimed: string[] = [];
    for (let i = 0; i < 4; i++) {
      await scanCandidates({
        salonId: "s",
        accountId: "a",
        initialWatermark: new Date("2026-10-01T00:00:00Z"),
        provider,
        store,
        onPageIds: async (page) => {
          for (const id of page) if (!processed.has(id)) { processed.add(id); newlyClaimed.push(id); }
          return true;
        },
        now: () => NOW,
        pageSize: 5,
        maxBacklogPages: 2,
      });
    }
    expect(newlyClaimed).toEqual(["m25", "m26", "m27", "m28", "m29"]);
  });

  it("ページのメールを処理(クレーム)できなかったら、そのページの続きを保存しない(読み飛ばさない)", async () => {
    const provider = inbox(Array.from({ length: 10 }, (_, i) => `m${i}`), 5);
    const store = memoryStore({ scanId: "scan-1", scanStartedAt: new Date("2026-10-07T00:00:00Z"), pageToken: "p5" });
    await expect(
      scanCandidates({
        salonId: "s",
        accountId: "a",
        initialWatermark: new Date("2026-10-01T00:00:00Z"),
        provider,
        store,
        onPageIds: async (page) => {
          if (page.includes("m5")) throw new Error("claim failed");
          return true;
        },
        now: () => NOW,
        pageSize: 5,
      })
    ).rejects.toThrow("claim failed");
    expect(store.state.pageToken).toBe("p5");
    expect(store.state.leased).toBe(false);
  });

  it("ページの途中で止めたら(締切・権限不足)、そのページの続きを保存しない。次回は同じページから読み直し、取りこぼさない", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const provider = inbox(ids, 5);
    const store = memoryStore({ scanId: "scan-1", scanStartedAt: new Date("2026-10-07T00:00:00Z"), pageToken: "p5" });
    const handled = new Set<string>();
    // 1回目: 続きのページ(m5〜m9)の2通目で止める。
    let budget = 1;
    const first = await scanCandidates({
      salonId: "s",
      accountId: "a",
      initialWatermark: new Date("2026-10-01T00:00:00Z"),
      provider,
      store,
      onPageIds: async (page) => {
        for (const id of page) {
          if (handled.has(id)) continue;
          if (page[0] === "m5" && budget-- <= 0) return false;
          handled.add(id);
        }
        return true;
      },
      now: () => NOW,
      pageSize: 5,
    });
    expect(first.stoppedByHandler).toBe(true);
    expect(first.completedScan).toBe(false);
    expect(store.state.pageToken).toBe("p5");
    expect(handled.has("m6")).toBe(false);
    // 2回目: 同じページから読み直し、残りも処理して読み切る。
    const second = await scanCandidates({
      salonId: "s",
      accountId: "a",
      initialWatermark: new Date("2026-10-01T00:00:00Z"),
      provider,
      store,
      onPageIds: async (page) => {
        for (const id of page) handled.add(id);
        return true;
      },
      now: () => NOW,
      pageSize: 5,
    });
    expect(second.completedScan).toBe(true);
    expect(new Set(handled)).toEqual(new Set(ids));
  });

  it("次のページを読む時間が無ければ読まずに止め(締切)、続きはそのまま残す", async () => {
    const provider = inbox(Array.from({ length: 10 }, (_, i) => `m${i}`), 5);
    const store = memoryStore({ scanId: "scan-1", scanStartedAt: new Date("2026-10-07T00:00:00Z"), pageToken: "p5" });
    let lists = 0;
    const result = await scanCandidates({
      salonId: "s",
      accountId: "a",
      initialWatermark: new Date("2026-10-01T00:00:00Z"),
      provider,
      store,
      onPageIds: async () => true,
      listTimeout: () => (lists++ < 2 ? 5_000 : null), // 開始の確認と先頭ページの分だけ時間がある
      now: () => NOW,
      pageSize: 5,
    });
    expect(result.stoppedForTime).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(store.state.pageToken).toBe("p5");
    expect(store.state.leased).toBe(false);

    // 始める時間も無ければ、リースも取らない。
    const none = await scanCandidates({
      salonId: "s",
      accountId: "a",
      initialWatermark: new Date("2026-10-01T00:00:00Z"),
      provider,
      store,
      onPageIds: async () => true,
      listTimeout: () => null,
    });
    expect(none).toMatchObject({ leased: false, stoppedForTime: true });
  });

  it("page token が無効になったら、同じ基準日時から読み直す", async () => {
    const provider = inbox(Array.from({ length: 8 }, (_, i) => `m${i}`), 5, { failToken: "p5" });
    const store = memoryStore({ scanId: "old", scanStartedAt: new Date("2026-10-06T00:00:00Z"), pageToken: "p5" });
    const result = await scanCandidates({
      salonId: "s",
      accountId: "a",
      initialWatermark: new Date("2026-10-01T00:00:00Z"),
      provider,
      store,
      onPageIds: async () => true,
      now: () => NOW,
      pageSize: 5,
      maxBacklogPages: 1,
    });
    expect(result.restartedScan).toBe(true);
    expect(store.state.scanId).not.toBe("old");
  });

  it("他の処理が読んでいる間(リース中)は読まない", async () => {
    const store = memoryStore({ leased: true });
    const provider = inbox(["m1"], 5);
    const result = await scanCandidates({
      salonId: "s",
      accountId: "a",
      initialWatermark: new Date("2026-10-01T00:00:00Z"),
      provider,
      store,
      onPageIds: async () => true,
    });
    expect(result.leased).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("取得開始日時より前は検索しない(先頭ページも基準日時より前を含めない)", async () => {
    const provider = inbox([], 5);
    const store = memoryStore({ watermark: new Date("2026-10-07T23:55:00Z") });
    await scanCandidates({
      salonId: "s",
      accountId: "a",
      initialWatermark: new Date("2026-10-07T23:55:00Z"),
      provider,
      store,
      onPageIds: async () => true,
      now: () => NOW,
    });
    const after = Math.floor(new Date("2026-10-07T23:55:00Z").getTime() / 1000);
    expect(provider.calls.every((c) => c.query.endsWith(`after:${after}`))).toBe(true);
  });
});
