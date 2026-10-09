import { buildCandidateSearchQuery } from "@/lib/notifications/mail/gmailSearchQuery";
import { MailProviderError, type MailProvider } from "@/lib/notifications/mail/MailProvider";

// Gmail の予約メール候補を、取りこぼさずに読み進める。
//   - 基準日時(watermark)より新しいメールを、1ページずつ読む。続き(page token)を保存し、
//     ページ数の上限や締切で打ち切っても次回そこから再開する。最後まで読み切ったときだけ基準日時を進める
//     (処理済みのメールが先頭に並んでいても、古い未処理のメールが取り残されない)。
//   - 各ページのメールを処理(onPageIds)し終えてから続きを保存する。途中で止めた(締切・権限不足等)ページは
//     続きを保存せず、次回同じページから読み直す(処理済みのメールは processed_emails で除く)。
//   - 毎回まず直近15分の先頭1ページを読む(長い続きを読んでいる間も、新着を待たせない)。
//   - page token が無効になった場合は、同じ基準日時から読み直す。
//   - 同時に2つの処理が同じ店舗を読まないよう、DB のリースを使う。

export interface ScanLease {
  leaseToken: string;
  watermark: Date;
  scanId: string | null;
  scanStartedAt: Date | null;
  pageToken: string | null;
}

export interface ScanStore {
  acquire(params: { salonId: string; accountId: string; initialWatermark: Date }): Promise<ScanLease | null>;
  progress(params: {
    salonId: string;
    leaseToken: string;
    scanId: string | null;
    scanStartedAt: Date | null;
    pageToken: string | null;
    completed: boolean;
    completedWatermark: Date | null;
    release: boolean;
  }): Promise<boolean>;
}

export interface ScanOptions {
  salonId: string;
  accountId: string;
  /** 取得を始める日時(lib/notifications/mail/fetchStart.ts。接続した日時ではない)。 */
  initialWatermark: Date;
  provider: MailProvider;
  store: ScanStore;
  /**
   * 1ページ分のメールIDを処理する。ページの全件を処理し終えたら true。途中で止めたら false
   * (そのページの続きは保存しない)。
   */
  onPageIds: (ids: string[]) => Promise<boolean>;
  /**
   * 次のページを読むときのタイムアウト(定期処理の締切に合わせて縮めた長さ)。null なら読む時間が無い。
   * 省略時は MailProvider の既定。
   */
  listTimeout?: () => number | null;
  now?: () => Date;
  pageSize?: number;
  maxBacklogPages?: number;
  headWindowMs?: number;
  /** 読み切ったとき、基準日時をどれだけ手前に残すか(配送の遅れ等で後から届くメールのため)。 */
  completionMarginMs?: number;
}

export interface ScanResult {
  leased: boolean;
  pagesRead: number;
  completedScan: boolean;
  restartedScan: boolean;
  /** 締切のため、読める続きを残して止めた。 */
  stoppedForTime: boolean;
  /** onPageIds が途中で止めた(締切・権限不足等。続きは保存していない)。 */
  stoppedByHandler: boolean;
}

export async function scanCandidates(options: ScanOptions): Promise<ScanResult> {
  const now = options.now ?? (() => new Date());
  const listTimeout = options.listTimeout ?? (() => undefined);
  const pageSize = options.pageSize ?? 50;
  const maxBacklogPages = options.maxBacklogPages ?? 8;
  const headWindowMs = options.headWindowMs ?? 15 * 60 * 1000;
  const marginMs = options.completionMarginMs ?? 24 * 60 * 60 * 1000;
  const result: ScanResult = {
    leased: false,
    pagesRead: 0,
    completedScan: false,
    restartedScan: false,
    stoppedForTime: false,
    stoppedByHandler: false,
  };

  if (listTimeout() === null) {
    result.stoppedForTime = true;
    return result;
  }
  const lease = await options.store.acquire({
    salonId: options.salonId,
    accountId: options.accountId,
    initialWatermark: options.initialWatermark,
  });
  if (!lease) return result;
  result.leased = true;

  let scanId = lease.scanId;
  let scanStartedAt = lease.scanStartedAt;
  let pageToken = lease.pageToken;

  try {
    // 新着: 直近の先頭1ページ(基準日時より前は含めない)。
    const headAfter = new Date(Math.max(now().getTime() - headWindowMs, lease.watermark.getTime()));
    const headTimeout = listTimeout();
    if (headTimeout === null) {
      result.stoppedForTime = true;
      return result;
    }
    let head;
    try {
      head = await options.provider.listPage(buildCandidateSearchQuery(headAfter), null, pageSize, { timeoutMs: headTimeout });
    } catch (error) {
      if (error instanceof MailProviderError && error.kind === "timeout") {
        result.stoppedForTime = true;
        return result;
      }
      throw error;
    }
    result.pagesRead++;
    if (!(await options.onPageIds(head.ids))) {
      result.stoppedByHandler = true;
      return result;
    }

    // 続き: 基準日時から最後まで(複数回に分けて)。
    const query = buildCandidateSearchQuery(lease.watermark);
    if (!scanId || !scanStartedAt) {
      scanId = crypto.randomUUID();
      scanStartedAt = now();
      pageToken = null;
    }
    for (let i = 0; i < maxBacklogPages; i++) {
      const timeoutMs = listTimeout();
      if (timeoutMs === null) {
        result.stoppedForTime = true;
        break;
      }
      let page;
      try {
        page = await options.provider.listPage(query, pageToken, pageSize, { timeoutMs });
      } catch (error) {
        if (error instanceof MailProviderError && error.kind === "timeout") {
          // 応答が遅い: このページは読めていないので続きを進めずに止める(次回同じ位置から)。
          result.stoppedForTime = true;
          break;
        }
        if (error instanceof MailProviderError && error.kind === "invalid_page_token" && pageToken) {
          scanId = crypto.randomUUID();
          scanStartedAt = now();
          pageToken = null;
          result.restartedScan = true;
          continue;
        }
        throw error;
      }
      result.pagesRead++;
      if (!(await options.onPageIds(page.ids))) {
        // このページの途中で止めた: 続きを進めない(次回このページから読み直す)。
        result.stoppedByHandler = true;
        break;
      }
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        await options.store.progress({
          salonId: options.salonId,
          leaseToken: lease.leaseToken,
          scanId,
          scanStartedAt,
          pageToken,
          completed: false,
          completedWatermark: null,
          release: false,
        });
        continue;
      }
      result.completedScan = true;
      await options.store.progress({
        salonId: options.salonId,
        leaseToken: lease.leaseToken,
        scanId: null,
        scanStartedAt: null,
        pageToken: null,
        completed: true,
        completedWatermark: new Date(scanStartedAt.getTime() - marginMs),
        release: false,
      });
      scanId = null;
      scanStartedAt = null;
      pageToken = null;
      break;
    }
  } finally {
    await options.store.progress({
      salonId: options.salonId,
      leaseToken: lease.leaseToken,
      scanId,
      scanStartedAt,
      pageToken,
      completed: false,
      completedWatermark: null,
      release: true,
    });
  }
  return result;
}
