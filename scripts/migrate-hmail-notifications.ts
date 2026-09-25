/**
 * hmail -> review-app(SalonPack) 予約通知データ 1回限りの移行スクリプト。
 *
 * ############################################################
 * # まだ実行しないこと。
 * ############################################################
 *
 * 実行前に、以下がすべて確定・完了している必要がある(PLAN参照):
 *   1. hmailとreview-appが同一Supabase Projectであること(確定済み)
 *   2. salon紐付けの人手検証が完了していること(PLAN 16節)
 *   3. .env.hmail-migration.local(後述)にhmail本番の値が入っていること
 *
 * ############################################################
 * # 【2026-09-13設計変更】複数スタッフ(source group)への対応
 * ############################################################
 * hmailでは「1店舗1Gmail」に対し、スタッフの人数分だけ同じGmailアドレスを
 * 共有する別々のhmail salon行を作ることで、スタッフごとに独立したLINE送信先
 * と通知設定を実現していた(テストデータではなく意図的な設計)。そのため、
 * このスクリプトは単一の --hmail-salon-id ではなく、同一店舗の全スタッフ分の
 * hmail salon idをカンマ区切りで受け取る --hmail-salon-ids を使う。
 *
 * mail_connections(Gmail接続)は「1店舗1Gmail」のまま変わらないため、この
 * スクリプトの対象外 -- hmail側に追加した一時的なmigration-bridgeルートが、
 * source group のうち代表1件(MIGRATION_SOURCE_HMAIL_SALON_ID)からGmail
 * refresh tokenを復号・再暗号化し、public.mail_connectionsへ直接書き込む
 * (旧APP_ENCRYPTION_KEYの値はどこにも出てこない設計、PLAN 11a節参照)。
 *
 * line_connections(スタッフごとのLINE送信先)は、source group の各hmail
 * salon idごとに1行ずつpublic.line_connectionsへ挿入する。冪等性のため、
 * 新しい行のidには**そのままhmail側のsalon_idを再利用する**(こうすることで
 * notification_historyを移行する際、旧hmail_salon_id == 新line_connections.id
 * という単純な対応になり、別途マッピングテーブルを持つ必要が無くなる)。
 *
 * notification_settings(店舗全体のmaster_enabledのみ)は、source group内の
 * 各hmail salonのmaster_enabledのOR(いずれか1つでもtrueならtrue)を採用し、
 * 1つのsalon_idの下へ1行だけ書き込む。
 *
 * processed_emailsはsource group全体のprovider_message_idの和集合を取り、
 * 重複を除いて新しい1つのsalon_idの下へ1回ずつ書き込む(統合直後のポーリング
 * が既知のメールを再度「新着」として拾わないようにするため)。
 *
 * ############################################################
 * # 本番Secretの扱いについて
 * ############################################################
 * hmail本番の値はチャット・コード・コミットへ一切貼らない。このリポジトリの
 * .gitignore は `.env*` を既にすべて無視するため、リポジトリ直下に
 *
 *   .env.hmail-migration.local
 *
 * というファイルを作り(1行1つの KEY=VALUE、.env.example と同じ書式)、以下を書く:
 *   DATABASE_URL=            (Supabaseへの直接Postgres接続文字列。REST用のURLではない)
 *   GOOGLE_CLIENT_ID=
 *   GOOGLE_CLIENT_SECRET=
 *   LINE_CHANNEL_ACCESS_TOKEN=
 *   LINE_CHANNEL_SECRET=
 *   LINE_OA_BASIC_ID=
 *
 * このスクリプトは起動時にこのファイルを process.loadEnvFile() で読み込み、
 * 全部が存在するかを検証する(値そのものは一切ログ出力しない)。
 * GOOGLE_CLIENT_ID/SECRET と LINE_CHANNEL_* はこのスクリプト自体はDB操作に
 * 使わない(review-appの本番envへ手動で設定するのはユーザー自身の作業)が、
 * hmail由来の秘密値を1つのファイルにまとめて存在確認できるようにするため、
 * ここでまとめて検証する。APP_ENCRYPTION_KEY / NOTIFICATIONS_ENCRYPTION_KEY は
 * このスクリプトでは扱わない(mail_connectionsの移行はmigration-bridge側の
 * 責務のため、PLAN 11a節参照)。
 *
 * 同一Supabaseプロジェクトであることを前提に、hmailスキーマ(hmail.*)から
 * review-app自身のテーブル(public.*)へ、Postgres内で直接INSERT ... SELECTする
 * (ネットワーク越しの読み書きではなく、同一DB内のコピーで完結させる)。
 * hmail.*テーブルへは一切書き込まない(常に読み取り専用ソース)。
 *
 * 使い方(まだ実行しない。例):
 *   npx tsx scripts/migrate-hmail-notifications.ts \
 *     --hmail-salon-ids=<hmail salon idをカンマ区切りで全スタッフ分> \
 *     --target-salon-id=<review-app側 public.salons.id> \
 *     --phase=static
 *
 * --phase=static
 *   line_connections / notification_settings をコピーする。めったに変わらない
 *   データのため、本番切替の準備段階(dry-run検証より前)に実行してよい。
 *   冪等(何度でも再実行可能)。
 *
 * --phase=dynamic
 *   processed_emails / notification_history を全件コピーする。常に増え続ける
 *   データのため、PLAN 23節の手順を厳守すること: 「cron-job.orgの旧hmail向け
 *   ジョブを停止」→「hmail側の直近cron実行が完了していることを確認」→
 *   このコマンドを実行 → 件数を確認 → 新cronを有効化、の順。
 *   冪等(再実行しても重複しない -- 切替直前の最終差分コピーもこのコマンドを
 *   もう一度実行するだけでよい)。--phase=static を先に実行しておくこと
 *   (notification_history.line_connection_idの外部キー制約を満たすため)。
 *
 * 本番アプリコードからは一切importされない、手動実行専用のツール。
 */

import { existsSync } from "fs";
import path from "path";
import postgres from "postgres";

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

const HMAIL_SALON_IDS = (getArg("hmail-salon-ids") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TARGET_SALON_ID = getArg("target-salon-id");
const PHASE = getArg("phase");

if (HMAIL_SALON_IDS.length === 0 || !TARGET_SALON_ID || (PHASE !== "static" && PHASE !== "dynamic")) {
  console.error(
    "Usage: tsx scripts/migrate-hmail-notifications.ts --hmail-salon-ids=<uuid1,uuid2,...> --target-salon-id=<uuid> --phase=static|dynamic"
  );
  process.exit(1);
}

if (new Set(HMAIL_SALON_IDS).size !== HMAIL_SALON_IDS.length) {
  console.error("--hmail-salon-ids に重複した値があります。");
  process.exit(1);
}

// --- ローカルの秘密値ファイルを読み込む(値はログ出力しない) ----------------

const SECRETS_FILE = path.resolve(getArg("secrets-file") ?? ".env.hmail-migration.local");
const REQUIRED_SECRET_KEYS = [
  "DATABASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "LINE_OA_BASIC_ID",
] as const;

function loadLocalSecrets(): void {
  if (!existsSync(SECRETS_FILE)) {
    throw new Error(
      `${SECRETS_FILE} が見つかりません。.env.example の書式で作成し、hmail本番の値を書いてください` +
        `(このファイルは .gitignore の .env* パターンで既に無視されます)。`
    );
  }
  process.loadEnvFile(SECRETS_FILE);

  const missing = REQUIRED_SECRET_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // キー名だけを報告し、値は一切出力しない。
    throw new Error(`${SECRETS_FILE} に以下のキーがありません: ${missing.join(", ")}`);
  }
}

loadLocalSecrets();

const DATABASE_URL = process.env.DATABASE_URL!;
const sql = postgres(DATABASE_URL, { ssl: "require" });

async function migrateStatic() {
  // line_connections: source group の各hmail salonを1行ずつ、そのsalon_idを
  // 新しい行のidとして再利用して挿入する(notification_historyの移行で
  // hmail_salon_id == line_connections.id という単純な対応にするため)。
  let lineConnectionsInserted = 0;
  for (const hmailSalonId of HMAIL_SALON_IDS) {
    const [lineRow] = await sql`
      select destination_id, status, linked_at
      from hmail.line_connections
      where salon_id = ${hmailSalonId}
    `;
    const [settingsRow] = await sql`
      select new_reservation_enabled, cancellation_enabled
      from hmail.notification_settings
      where salon_id = ${hmailSalonId}
    `;
    if (!lineRow) {
      console.warn(`line_connections: hmail salon ${hmailSalonId} に行が見つかりませんでした(スキップ)`);
      continue;
    }
    await sql`
      insert into public.line_connections
        (id, salon_id, destination_id, status, new_reservation_enabled, cancellation_enabled,
         linked_at, migrated_from_hmail_salon_id, updated_at)
      values
        (${hmailSalonId}, ${TARGET_SALON_ID!}, ${lineRow.destination_id}, ${lineRow.status},
         ${settingsRow?.new_reservation_enabled ?? true}, ${settingsRow?.cancellation_enabled ?? true},
         ${lineRow.linked_at}, ${hmailSalonId}, now())
      on conflict (id) do update set
        destination_id = excluded.destination_id,
        status = excluded.status,
        new_reservation_enabled = excluded.new_reservation_enabled,
        cancellation_enabled = excluded.cancellation_enabled,
        linked_at = excluded.linked_at,
        updated_at = now()
    `;
    lineConnectionsInserted++;
  }
  console.log(`line_connections: ${lineConnectionsInserted}/${HMAIL_SALON_IDS.length} 件コピー(スタッフ人数分)`);

  // notification_settings(店舗全体のmaster_enabledのみ): source group内の
  // いずれか1つでもtrueならtrue(OR)を採用する。
  const masterRows = await sql<{ master_enabled: boolean }[]>`
    select master_enabled from hmail.notification_settings
    where salon_id = any(${sql.array(HMAIL_SALON_IDS)})
  `;
  const masterEnabled = masterRows.some((r) => r.master_enabled === true);
  await sql`
    insert into public.notification_settings (salon_id, master_enabled, updated_at)
    values (${TARGET_SALON_ID!}, ${masterEnabled}, now())
    on conflict (salon_id) do update set
      master_enabled = excluded.master_enabled,
      updated_at = now()
  `;
  console.log(
    `notification_settings: master_enabled=${masterEnabled}(source groupの${masterRows.length}件からORで決定)`
  );
}

async function migrateDynamic() {
  // processed_emails: source group全体のprovider_message_idの和集合を取り、
  // 重複を除いて新しい1つのsalon_idの下へ1回ずつ挿入する。dedupキーは
  // (salon_id, provider_message_id)そのもの(このテーブル本来のUNIQUE制約)。
  const insertedEmails = await sql`
    insert into public.processed_emails (salon_id, provider_message_id, event_type, processed_at)
    select distinct on (provider_message_id) ${TARGET_SALON_ID!}, provider_message_id, event_type, processed_at
    from hmail.processed_emails
    where salon_id = any(${sql.array(HMAIL_SALON_IDS)})
    order by provider_message_id, processed_at asc
    on conflict (salon_id, provider_message_id) do nothing
    returning id
  `;
  const [{ count: targetEmailCount }] = await sql<{ count: number }[]>`
    select count(*)::int as count from public.processed_emails where salon_id = ${TARGET_SALON_ID!}
  `;
  const perSourceEmailCounts = await sql<{ salon_id: string; count: number }[]>`
    select salon_id, count(*)::int as count from hmail.processed_emails
    where salon_id = any(${sql.array(HMAIL_SALON_IDS)})
    group by salon_id
  `;
  console.log(
    `processed_emails: 今回 ${insertedEmails.length} 件を新規コピー。review-app側合計(統合後)=${targetEmailCount}。` +
      `hmail側内訳(重複含む個別件数)=${perSourceEmailCounts.map((r) => `${r.salon_id}:${r.count}`).join(", ")}`
  );

  // notification_history: line_connection_id には、その履歴が元々属していた
  // hmail salonのidをそのまま使う(staticフェーズでline_connections.idとして
  // 既に再利用済みのため、ここで改めてマッピングを引く必要がない)。
  const insertedHistory = await sql`
    insert into public.notification_history
      (id, salon_id, line_connection_id, event_type, provider_message_id, line_text, status, attempts, error_message, sent_at, updated_at)
    select id, ${TARGET_SALON_ID!}, salon_id, event_type, provider_message_id, line_text, status, attempts, error_message, sent_at, updated_at
    from hmail.notification_history
    where salon_id = any(${sql.array(HMAIL_SALON_IDS)})
    on conflict (id) do update set
      status = excluded.status,
      attempts = excluded.attempts,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
    returning id
  `;
  const [{ count: targetHistoryCount }] = await sql<{ count: number }[]>`
    select count(*)::int as count from public.notification_history where salon_id = ${TARGET_SALON_ID!}
  `;
  const perSourceHistoryCounts = await sql<{ salon_id: string; count: number }[]>`
    select salon_id, count(*)::int as count from hmail.notification_history
    where salon_id = any(${sql.array(HMAIL_SALON_IDS)})
    group by salon_id
  `;
  console.log(
    `notification_history: 今回 ${insertedHistory.length} 件を新規コピー/更新。review-app側合計=${targetHistoryCount}。` +
      `hmail側内訳=${perSourceHistoryCounts.map((r) => `${r.salon_id}:${r.count}`).join(", ")}`
  );
}

async function main() {
  console.log(`phase=${PHASE} hmail-salon-ids=${HMAIL_SALON_IDS.join(",")} target-salon-id=${TARGET_SALON_ID}`);
  if (PHASE === "static") {
    await migrateStatic();
  } else {
    await migrateDynamic();
  }
  await sql.end();
}

main().catch((err) => {
  // postgres.jsのエラーオブジェクトそのものを出力すると、接続文字列の断片等が
  // 含まれる可能性があるため、メッセージのみを出す(秘密値をログに残さないため)。
  console.error("移行スクリプトが失敗しました:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
