import { AsyncLocalStorage } from "node:async_hooks";

// DB への問い合わせに使ってよい時間を、呼び出しの文脈ごとに決める仕組み。
// 定期処理は、締切(lib/notifications/jobs/runBudget.ts)から求めた残り時間をここに設定し、
// lib/notifications/admin.ts のクライアントが各問い合わせのタイムアウトとして使う
// (関数ごとの引数を増やさずに、経路上のすべての問い合わせを全体の残り時間で打ち切る)。
// 設定が無い文脈(画面・Server Action)では、admin.ts の既定の上限だけが効く。

const storage = new AsyncLocalStorage<() => number>();

/** fn の中で行う DB への問い合わせを、limitMs() ミリ秒(問い合わせを始める時点で評価)で打ち切る。 */
export function withDbTimeLimit<T>(limitMs: () => number, fn: () => Promise<T>): Promise<T> {
  return storage.run(limitMs, fn);
}

/** 今の文脈で DB への問い合わせに使ってよい時間。設定が無ければ null。 */
export function currentDbTimeLimitMs(): number | null {
  const limit = storage.getStore();
  return limit ? limit() : null;
}
