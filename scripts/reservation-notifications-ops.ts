/**
 * 予約通知の運用 CLI(運営専用。本番アプリからは import しない)。
 * 既定は確認だけ。書き込みは --apply、旧側(hmail)への書き込みはさらに --approve-hmail-write が必要。
 *
 *   npx tsx scripts/reservation-notifications-ops.ts list [--awaiting]
 *       運用状態の一覧。Google の再接続の状況(未接続 / 再接続済み:初回・最終の接続日時・アカウント・権限 /
 *       再接続が必要)、旧側停止の確認日時、最新の照合結果、開始日時を表示する
 *       (お客様からの連絡が無くても、運営側で再接続を確認できる)。
 *   ... map --salon-id=<uuid> --mailbox=<旧側の予約受信用Gmail> --expected-staff=<人数> [--note=...] [--source-schema=hmail] [--apply] --by=<名前>
 *       対応表(新側の店舗 ↔ 旧側の予約受信用 Gmail ↔ スタッフの人数)に登録する。新側の店舗は Gmail アドレスから
 *       推定しない(運営がお客様・契約を確認したうえで指定する)。ログイン用のメールアドレスではなく、旧側のスタッフ行が
 *       予約メールを受け取っている Gmail を指定する。見つかった旧側のスタッフの人数が違えば登録しない。
 *   ... check-legacy --salon-id=<uuid>      旧側の状態と、登録したスタッフの集合が今も正しいか(増えた・減った・受信箱の変更)
 *   ... history --salon-id=<uuid>           Google 連携の履歴
 *   ... status --salon-id=<uuid>            配信の件数・確認待ち・期限切れの結果不明・送信中
 *   ... stop-legacy --salon-id=<uuid> --cron-paused-at=<ISO> [--attest-run-ended=<id,...>] [--apply --approve-hmail-write]
 *   ... confirm-cutover --salon-id=<uuid> --cron-paused-at=<ISO> --cron-resumed-at=<ISO> [--attest-run-ended=...] [--apply] --by=<名前>
 *   ... reconcile --salon-id=<uuid> --window-from=<ISO> [--apply] --by=<名前>
 *   ... accept-reconciliation --run-id=<uuid> --by=<名前>
 *   ... resolve --delivery-id=<uuid> --as=sent|skipped|send_now|retry_same_key|manual_resend --reason=<理由>
 *         [--accept-duplicate-risk] [--apply] --by=<名前>
 *   ... activate --salon-id=<uuid> [--mail-fetch-since=<ISO> --reason=<理由>] [--apply] --by=<名前>
 *   ... pause --salon-id=<uuid> --reason=<理由> [--apply] --by=<名前>
 *   ... rollback --salon-id=<uuid> --mode=A|B [--apply --approve-hmail-write] --by=<名前>
 *
 * 接続先: .env.hmail-migration.local の DATABASE_URL(値は表示しない)。
 */
import { getArg, hasFlag, operatorName, parseDateArg, requireArg, runCli } from "./notifications-ops/connect";
import {
  acceptReconciliation,
  activate,
  confirmCutover,
  connectionHistory,
  deliveryStatus,
  legacyCheck,
  listOperations,
  pause,
  reconcile,
  registerMapping,
  resolveDelivery,
  rollback,
  stopLegacy,
  type ResolveMode,
} from "./notifications-ops/core";

const command = process.argv[2];
const log = (line: string) => console.log(line);
const fmt = (d: Date | null | undefined) => (d ? d.toISOString() : "—");
const attest = () => (getArg("attest-run-ended") ?? "").split(",").filter(Boolean);

void runCli(async (sql) => {
  switch (command) {
    case "list": {
      const rows = await listOperations(sql, { awaitingOnly: hasFlag("awaiting") });
      for (const r of rows) {
        log(
          `${r.salonId} ${r.salonName} state=${r.state}${r.legacy ? "(旧サービス利用)" : ""}\n` +
            `  Google: ${r.googleConnection} 初回=${fmt(r.firstConnectedAt)} 最終=${fmt(r.lastReconnectedAt)} ` +
            `アカウント=${r.accountEmail ?? "—"} Gmail権限=${r.grantedScopes.includes("https://www.googleapis.com/auth/gmail.readonly") ? "あり" : "なし"}\n` +
            `  旧側停止確認=${fmt(r.legacyStopConfirmedAt)} 照合=${r.latestReconciliation ? `${fmt(r.latestReconciliation.ranAt)} 未解決${r.latestReconciliation.unresolved} ${r.latestReconciliation.accepted ? "受入済" : "未受入"}` : "—"} 開始=${fmt(r.activatedAt)}` +
            (r.legacy
              ? `\n  旧側の予約受信用Gmail=${r.legacyMailbox ?? "対応表なし"} 接続アカウントと${r.gmailMatchesLegacyMailbox === null ? "—" : r.gmailMatchesLegacyMailbox ? "一致" : "不一致"} ` +
                `旧側の確認=${r.legacyCheck ? `${r.legacyCheck.state}${r.legacyCheck.reason ? `(${r.legacyCheck.reason})` : ""}` : "—"}`
              : "")
        );
      }
      if (rows.length === 0) log("対象の店舗はありません。");
      break;
    }
    case "map": {
      const expected = Number(requireArg("expected-staff"));
      await registerMapping(sql, {
        salonId: requireArg("salon-id"),
        mailbox: requireArg("mailbox"),
        expectedStaffCount: expected,
        sourceSchema: getArg("source-schema") ?? "hmail",
        note: getArg("note") ?? null,
        apply: hasFlag("apply"),
        by: operatorName(),
        log,
      });
      break;
    }
    case "check-legacy": {
      const c = await legacyCheck(sql, requireArg("salon-id"));
      log(`状態=${c.state}${c.reason ? `(${c.reason})` : ""} 予約受信用Gmail=${c.legacyMailbox ?? "—"} 対応表の人数=${c.expectedStaffCount ?? "—"}`);
      log(`  登録したスタッフ: ${c.registeredIds.join(", ") || "なし"}`);
      if (c.unregisteredIds.length) log(`  ✗ 登録のあとに増えた旧側の行: ${c.unregisteredIds.join(", ")}`);
      if (c.missingIds.length) log(`  ✗ 旧側に無くなった行: ${c.missingIds.join(", ")}`);
      if (c.mailboxMismatchIds.length) log(`  ✗ 予約受信用Gmailが変わった行: ${c.mailboxMismatchIds.join(", ")}`);
      if (c.activeIds.length) log(`  旧側で処理対象の行: ${c.activeIds.join(", ")}`);
      break;
    }
    case "history": {
      for (const e of await connectionHistory(sql, requireArg("salon-id"))) {
        log(`${fmt(e.occurred_at)} ${e.feature ?? "-"} ${e.event} ${e.account_email ?? ""}`);
      }
      break;
    }
    case "status": {
      const s = await deliveryStatus(sql, requireArg("salon-id"));
      for (const c of s.counts) log(`${c.origin}/${c.status}: ${c.count}`);
      log(`確認待ち: ${s.review.length} 件`);
      for (const r of s.review) log(`  ${r.id} メール=${r.provider_message_id} スタッフ=${r.line_connection_id} 理由=${r.skip_reason ?? "—"}`);
      log(`retry key の期限を過ぎた結果不明: ${s.unknownExpired.length} 件(自動では再送しません)`);
      log(`送信中(結果待ち): ${s.inflight.length} 件`);
      log(`分類できなかったメール: ${s.unprocessable} 件`);
      break;
    }
    case "stop-legacy":
      await stopLegacy(sql, {
        salonId: requireArg("salon-id"),
        cronPausedAt: parseDateArg("cron-paused-at"),
        attestRunEnded: attest(),
        apply: hasFlag("apply"),
        approveHmailWrite: hasFlag("approve-hmail-write"),
        log,
      });
      break;
    case "confirm-cutover":
      await confirmCutover(sql, {
        salonId: requireArg("salon-id"),
        cronPausedAt: parseDateArg("cron-paused-at"),
        cronResumedAt: parseDateArg("cron-resumed-at"),
        attestRunEnded: attest(),
        apply: hasFlag("apply"),
        by: operatorName(),
        log,
      });
      break;
    case "reconcile":
      await reconcile(sql, {
        salonId: requireArg("salon-id"),
        windowFrom: parseDateArg("window-from"),
        apply: hasFlag("apply"),
        by: operatorName(),
        log,
      });
      break;
    case "accept-reconciliation":
      await acceptReconciliation(sql, { runId: requireArg("run-id"), by: operatorName(), log });
      break;
    case "resolve": {
      const mode = requireArg("as") as ResolveMode;
      if (!["sent", "skipped", "send_now", "retry_same_key", "manual_resend"].includes(mode)) throw new Error("--as の値が正しくありません。");
      await resolveDelivery(sql, {
        deliveryId: requireArg("delivery-id"),
        mode,
        reason: requireArg("reason"),
        acceptDuplicateRisk: hasFlag("accept-duplicate-risk"),
        apply: hasFlag("apply"),
        by: operatorName(),
        log,
      });
      break;
    }
    case "activate":
      await activate(sql, {
        salonId: requireArg("salon-id"),
        mailFetchSince: getArg("mail-fetch-since") ? parseDateArg("mail-fetch-since") : null,
        reason: getArg("reason") ?? null,
        apply: hasFlag("apply"),
        by: operatorName(),
        log,
      });
      break;
    case "pause":
      await pause(sql, { salonId: requireArg("salon-id"), reason: requireArg("reason"), apply: hasFlag("apply"), by: operatorName(), log });
      break;
    case "rollback": {
      const mode = requireArg("mode");
      if (mode !== "A" && mode !== "B") throw new Error("--mode は A か B です。");
      await rollback(sql, {
        salonId: requireArg("salon-id"),
        mode,
        apply: hasFlag("apply"),
        approveHmailWrite: hasFlag("approve-hmail-write"),
        by: operatorName(),
        log,
      });
      break;
    }
    default:
      console.error("使い方はファイル先頭のコメントを見てください。");
      process.exitCode = 1;
  }
});
