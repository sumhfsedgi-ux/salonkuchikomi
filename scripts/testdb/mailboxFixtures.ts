// testdb テスト用の、予約メールの受信箱(Gmail の代わり)と時計。
//   - 検索条件の after:<epoch秒> を守る(取得開始日時より前のメールは一覧に出さない)。
//     以前のモックは検索条件を無視していたため、取得開始日時の誤り(接続日時での切り詰め)を検出できなかった。
//   - 新しい順に並べ、page token で続きを返す。
//   - 仮想の時計を渡すと、呼び出しごとに「かかった時間」だけ時計を進める。指定されたタイムアウトより
//     遅い呼び出しは、タイムアウトの分だけ進めて timeout のエラーにする(遅い通信・締切の検証用)。
import { MailProviderError, type MailCallOptions, type MailProvider } from "@/lib/notifications/mail/MailProvider";

export const HOTPEPPER_FROM = "SALON BOARD <yoyaku_system@salonboard.com>";

export interface TestMail {
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: Date;
}

export function reservationMail(receivedAt: Date, body = "テスト予約本文", subject = "予約連絡"): TestMail {
  return { from: HOTPEPPER_FROM, subject, bodyText: body, receivedAt };
}

export interface VirtualClock {
  now(): number;
  advance(ms: number): void;
}

export function virtualClock(start = Date.now()): VirtualClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface InboxOptions {
  clock?: VirtualClock;
  /** 一覧1回・本文1通の取得にかかる時間(仮想の時計を進める)。 */
  listLatencyMs?: number;
  getLatencyMs?: number;
  /** 呼び出しの前に投げるエラー(権限不足などの再現)。null なら通常どおり。 */
  failWith?: (op: "list" | "get") => MailProviderError | null;
}

export interface TestInbox extends MailProvider {
  calls: Array<{ op: "list" | "get"; id?: string; timeoutMs?: number }>;
}

export function inbox(mails: Record<string, TestMail>, options: InboxOptions = {}): TestInbox {
  const calls: TestInbox["calls"] = [];
  const spend = (latency: number | undefined, call?: MailCallOptions) => {
    if (!options.clock || !latency) return;
    if (call?.timeoutMs !== undefined && latency > call.timeoutMs) {
      options.clock.advance(call.timeoutMs);
      throw new MailProviderError("timeout");
    }
    options.clock.advance(latency);
  };
  return {
    calls,
    async listPage(query, pageToken, pageSize, call) {
      calls.push({ op: "list", timeoutMs: call?.timeoutMs });
      const failure = options.failWith?.("list");
      if (failure) throw failure;
      spend(options.listLatencyMs, call);
      const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0) * 1000;
      const ids = Object.entries(mails)
        .filter(([, m]) => m.receivedAt.getTime() >= after)
        .sort(([, a], [, b]) => b.receivedAt.getTime() - a.receivedAt.getTime())
        .map(([id]) => id);
      const start = pageToken ? Number(pageToken.slice(1)) : 0;
      const next = start + pageSize < ids.length ? `p${start + pageSize}` : null;
      return { ids: ids.slice(start, start + pageSize), nextPageToken: next };
    },
    async getMessage(id, call) {
      calls.push({ op: "get", id, timeoutMs: call?.timeoutMs });
      const failure = options.failWith?.("get");
      if (failure) throw failure;
      spend(options.getLatencyMs, call);
      const m = mails[id];
      if (!m) throw new MailProviderError("not_found");
      return { id, ...m };
    },
  };
}

/** 店舗ごとに別の受信箱を返す(定期処理は DB 上の稼働中の店舗をすべて処理するため)。 */
export function providersBySalon(boxes: Map<string, TestInbox>) {
  return (_accessToken: string, context: { salonId: string }) => boxes.get(context.salonId) ?? inbox({});
}
