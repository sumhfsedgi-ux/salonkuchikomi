import type { RefreshResult } from "@/lib/googleReviews/types";

// 届いた口コミの画面を開いたときの自動の取り込み(既存の［更新］と同じ処理を1回呼ぶ)の判定。
// 取得の間隔(5分)・取得中の重複は、サーバー(lib/gbp/inbox.ts の refresh と DB の gbp_begin_sync)がそのまま止める。

/** 失敗を画面に出すか。手動の［更新］はすべて出す。自動の取り込みでは、一時的な失敗(取得中・混雑・通信)は出さない。 */
export function shouldShowRefreshError(result: RefreshResult, auto: boolean): boolean {
  if (result.ok) return false;
  return !auto || !("temporary" in result && result.temporary);
}

/**
 * 自動の取り込みのあと、一覧を読み直すか。
 *   ・取り込んでいない(5分以内で取得を省いた:最終更新の時刻が変わらない)なら読み直さない
 *   ・取り込みの間に、利用者が絞り込み・並び順を変えた・続きを読み込んだなら、表示中の一覧を入れ替えない
 */
export function shouldReloadAfterAutoRefresh(input: { shownLastCheckedAt: string | null; lastCheckedAt: string; listChanged: boolean }): boolean {
  if (input.listChanged) return false;
  if (input.shownLastCheckedAt === null) return true;
  return Date.parse(input.shownLastCheckedAt) !== Date.parse(input.lastCheckedAt);
}
