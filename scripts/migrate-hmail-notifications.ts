/**
 * hmail → SalonPack 予約通知の静的データの移行(運営専用。本番アプリからは import しない)。
 *
 * 【方針(2026-10-08)】hmail の Gmail 認証トークンは移行しない(hmail の Google OAuth クライアントの
 * 認証情報が所在不明のため)。お客様には SalonPack で Google に再接続してもらう。migration-bridge は使わない。
 * このスクリプトは、Google の認証と関係の無いデータだけを移す:
 *   - スタッフごとの LINE の送信先(hmail のスタッフの salon id を line_connections.id として再利用する。
 *     スタッフに再登録を求めない。口コミ通知の設定もこの id に結び付くため、id を変えない)
 *   - スタッフ個人の通知設定(個人の master_enabled を種別ごとの設定へ AND で畳み込む。
 *     設定が無いスタッフは OFF。scripts/migrateHmailSettingsFold.ts)
 *   - 予約通知を使う機能として選択済みにし、旧サービス利用店舗(切り替え待ち)として登録する。
 *     スタッフごとの旧側の接続状態を控える(切り戻しで全員を無条件に connected へ戻さないため)。
 * 送信状態の照合・旧側の停止・開始は scripts/reservation-notifications-ops.ts で行う。
 *
 * 【先に対応表へ登録する】scripts/reservation-notifications-ops.ts map で、運営が確認した
 * 「移行先の店舗 ↔ 旧側の予約受信用 Gmail ↔ スタッフの人数」を登録しておく。このスクリプトは、指定された
 * スタッフの id の集合が、その Gmail で見つかる旧側のスタッフ行と完全に一致するときだけ書き込む
 * (1人の指定漏れ・他店舗の id・存在しない id・別店舗へ移行済みの id・人数の不一致は、書き込む前に拒否)。
 *
 *   npx tsx scripts/migrate-hmail-notifications.ts \
 *     --hmail-salon-ids=<スタッフ全員分の hmail salon id をカンマ区切り> \
 *     --target-salon-id=<SalonPack の salons.id> [--source-schema=hmail] [--apply] --by=<作業者>
 *
 * 既定は確認だけ(書き込まない)。接続先は .env.hmail-migration.local の DATABASE_URL(値は表示しない)。
 * hmail のスキーマへは一切書き込まない(読み取りだけ)。
 */
import { getArg, hasFlag, operatorName, requireArg, runCli } from "./notifications-ops/connect";
import { staticMigrate } from "./notifications-ops/core";

const ids = requireArg("hmail-salon-ids")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (ids.length === 0 || new Set(ids).size !== ids.length) {
  console.error("--hmail-salon-ids はスタッフ全員分の id を重複なく指定してください。");
  process.exit(1);
}

void runCli(async (sql) => {
  await staticMigrate(sql, {
    targetSalonId: requireArg("target-salon-id"),
    hmailSalonIds: ids,
    sourceSchema: getArg("source-schema") ?? "hmail",
    apply: hasFlag("apply"),
    by: operatorName(),
    log: (line) => console.log(line),
  });
});
