// 予約通知のtestdbテスト共通セットアップ。.env.testdb.local を読み、
// process.env をテスト用プロジェクトの値に差し替える(lib/notifications/admin.ts の
// getNotificationsSupabaseAdmin()はprocess.envを遅延参照するため、各テストの
// 最初のDB呼び出しより前にこれを呼んでおけば、本番相当のコードがそのまま
// テスト用プロジェクトに向く)。
import { TargetError, assertTestDatabase, buildChildEnv, databaseOptions, loadTestTarget } from "./target.mjs";
import postgres from "postgres";

export function setupNotificationsTestEnv() {
  let target: ReturnType<typeof loadTestTarget>;
  try {
    target = loadTestTarget({ requireDatabaseUrl: true });
  } catch (err) {
    if (err instanceof TargetError) {
      throw new Error(`テスト用DBの設定を読み込めません: ${err.message}`);
    }
    throw err;
  }
  const env = buildChildEnv(target, process.env, undefined) as Record<string, string>;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return target;
}

/** 並行実行の検証用に、同じテストDBへの独立したpostgres接続を複数開く。 */
export async function openDirectConnections(target: ReturnType<typeof loadTestTarget>, count: number) {
  const connections = Array.from({ length: count }, () =>
    postgres({ ...databaseOptions(target.testdb), max: 1, onnotice: () => {} })
  );
  // 接続先が本当にテスト用DBであることを、最初の1本で確かめる
  // (共有・本番DBに並行実行の検証クエリを投げてしまう事故を防ぐ)。
  await assertTestDatabase(connections[0], target.ref);
  return connections;
}

export async function closeConnections(connections: ReturnType<typeof postgres>[]) {
  await Promise.all(connections.map((c) => c.end({ timeout: 5 })));
}
