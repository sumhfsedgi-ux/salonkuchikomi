/**
 * 店舗の契約(salons.plan)を、運営が契約を確認したうえで変更する(運営専用)。
 * 通常は運営管理の画面(/ops/salons/<id> の「契約と利用許可」)で変更する。この CLI は画面が使えないときの代わり。
 * 利用開始待ちの新しい店舗(0025 の service_status = pending で、既存の店舗ではない)の契約プランは変えない。そのプランは予定で、
 * 契約ではないため(0026)。既存の店舗は、止めている間も変えられる(利用の再開・停止の解除はしない)。
 * 料金・請求はこの CLI では扱わない(契約の確認は運営の手順で行う)。
 * 変更は salon_plan_changes と操作履歴(operator_audit_log。画面の「変更履歴」)に記録される(0022・0024)。
 * 画面と同じ規則になる(0024): 予約通知が使えなくなる変更では「権限による停止」を記録し、salonpack に戻しても
 * 自動では再開しない(運営が画面から停止を解除する)。開いたままの管理画面からの古い内容での保存は、版数で拒否される。
 *
 *   npx tsx scripts/salon-contract.ts show --salon-id=<uuid>
 *   npx tsx scripts/salon-contract.ts set-plan --salon-id=<uuid> --plan=reviews|salonpack --note=<契約の確認内容> [--apply] --by=<作業者>
 *
 * 既定は確認だけ。接続先は .env.hmail-migration.local の DATABASE_URL(値は表示しない)。
 */
import { hasFlag, operatorName, requireArg, runCli } from "./notifications-ops/connect";

const command = process.argv[2];

void runCli(async (sql) => {
  const salonId = requireArg("salon-id");
  // service_status・registration_source は 0025 で足した列(0025 の前の DB でも動くよう、行を JSON にして読む)
  const [salon] = await sql<{ id: string; name: string; plan: string; service_status: string | null; registration_source: string | null }[]>`
    select s.id, s.name, s.plan, to_jsonb(s) ->> 'service_status' as service_status, to_jsonb(s) ->> 'registration_source' as registration_source
      from public.salons s where s.id = ${salonId}`;
  if (!salon) throw new Error("店舗が見つかりません。");
  // 新しい店舗(登録の途中)が利用開始待ちのあいだは、プランは予定(契約ではない)。既存の店舗は、止めている間も契約のまま
  const plannedOnly = salon.service_status === "pending" && salon.registration_source !== "existing";
  console.log(`店舗 ${salon.id} ${salon.name} 現在の契約=${plannedOnly ? `なし(利用開始待ち。予定のプラン=${salon.plan})` : salon.plan}`);
  const history = await sql<{ changed_at: Date; old_plan: string | null; new_plan: string; changed_by: string; note: string | null }[]>`
    select changed_at, old_plan, new_plan, changed_by, note from public.salon_plan_changes where salon_id = ${salonId} order by changed_at`;
  for (const h of history) console.log(`  ${h.changed_at.toISOString()} ${h.old_plan} → ${h.new_plan} (${h.changed_by}) ${h.note ?? ""}`);
  if (command === "show") return;
  if (command !== "set-plan") throw new Error("show か set-plan を指定してください。");
  if (plannedOnly) {
    throw new Error("利用開始待ちの新しい店舗の契約プランは変更できません(契約プランは、利用を始めるときに決まります)。");
  }

  const plan = requireArg("plan");
  if (plan !== "reviews" && plan !== "salonpack") throw new Error("--plan は reviews か salonpack です。");
  const note = `${operatorName()} ${requireArg("note")}`.slice(0, 300);
  if (plan === salon.plan) {
    console.log("変更はありません。");
    return;
  }
  console.log(`変更: ${salon.plan} → ${plan}`);
  if (!hasFlag("apply")) {
    console.log("確認だけです。--apply で変更します。");
    return;
  }
  await sql.begin(async (tx) => {
    await tx`select set_config('salonpack.change_note', ${note}, true), set_config('salonpack.actor_label', ${operatorName()}, true)`;
    await tx`update public.salons set plan = ${plan}, updated_at = now() where id = ${salonId}`;
  });
  console.log("契約を変更しました。お客様の画面・メニューに反映されます(データ・Google連携は変わりません)。");
  const [hold] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.salon_feature_holds where salon_id = ${salonId} and released_at is null`;
  if (hold.n > 0) {
    console.log("権限による停止が開いています(予約通知など)。再開するには、運営管理の画面で利用許可を確認してから停止を解除してください。");
  }
});
