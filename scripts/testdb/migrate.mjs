// テスト用の Supabase プロジェクトにだけ、supabase/migrations を順に適用する。
//
//   npm run testdb:migrate                         適用の状況を見るだけ(書き込まない)
//   npm run testdb:migrate -- --apply               未適用のものを、番号の順に適用する(1つずつトランザクション)
//   --through=0020                                  ここまで(既定はすべて)
//   --assume-applied-through=0012                   手で適用済みの番号まで、実行せずに「適用済み」と記録する(初回だけ)
//   --reapply-changed                               記録のあとに変わった 0020 以降のファイルを、もう一度適用する
//
// 接続の前に scripts/testdb/target.mjs で接続先を確かめる(TEST_DATABASE_URL が TEST_SUPABASE_PROJECT_REF のもので、
// 共有の設定とは違うこと)。接続のあとも、hmail のスキーマが無いこと・記録した印が同じプロジェクトであることを確かめる。
// 合わなければ何も書き込まずに止める。共有・本番の DB には適用しない。予約通知の移行スクリプトは実行しない。
// 接続文字列・秘密の値は表示しない。

import postgres from "postgres";
import { TargetError, assertTestDatabase, loadTestTarget, databaseOptions } from "./target.mjs";
import { MigrationError, checkSchema, describeError, listMigrationFiles, runMigrations } from "./migrations.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? null;

function stop(message) {
  console.error(`\n[testdb:migrate] 停止しました:${message}\n共有・本番の環境には接続・適用していません。`);
  process.exit(1);
}

const through = option("through");
const assumeThrough = option("assume-applied-through");
for (const value of [through, assumeThrough]) {
  if (value !== null && !/^\d{4}$/.test(value)) stop("--through・--assume-applied-through は4桁の番号で指定してください。");
}

let target;
try {
  target = loadTestTarget({ requireDatabaseUrl: true });
} catch (err) {
  if (err instanceof TargetError) stop(err.message);
  throw err;
}

const sql = postgres({ ...databaseOptions(target.testdb), max: 1, onnotice: () => {}, connect_timeout: 20 });
let exitCode = 0;
try {
  const marker = await assertTestDatabase(sql, target.ref);
  console.log(`[testdb:migrate] 接続先:テスト用プロジェクト ${target.ref}(hmail のスキーマなし${marker.hasMarker ? "・記録の印が一致" : "・初回"})`);
  const result = await runMigrations(sql, {
    ref: target.ref,
    files: listMigrationFiles({ through }),
    hasMarker: marker.hasMarker,
    apply: flag("apply"),
    reapplyChanged: flag("reapply-changed"),
    assumeThrough,
  });
  if (!result.wrote) {
    console.log("\n状況を見ただけです(書き込んでいません)。適用するときは --apply を付けてください。");
  } else if (flag("apply")) {
    const c = await checkSchema(sql);
    console.log(
      `\n適用のあとの確認:notification_deliveries ${c.deliveries ? "あり" : "なし"}・google_accounts ${c.google_accounts ? "あり" : "なし"}・` +
        `運用状態 ${c.operations ? "あり" : "なし"}・claim関数(v2) ${c.claim_fn ? "あり" : "なし"}・結果記録関数 ${c.outcome_fn ? "あり" : "なし"}・` +
        `RLS ${c.rls ? "有効" : "要確認"}`,
    );
  }
} catch (err) {
  exitCode = 1;
  if (err instanceof TargetError || err instanceof MigrationError) console.error(`\n[testdb:migrate] 停止しました:${err.message}`);
  else console.error(`\n[testdb:migrate] 停止しました:DB の処理に失敗しました:${describeError(err)}`);
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(exitCode);
