/**
 * 店舗の契約(salons.plan)を、運営が契約を確認したうえで変更する(運営専用)。
 * 新規店舗は常に reviews で作られる(app/dashboard/actions.ts)。予約通知・ブログを契約したお客様は、
 * この CLI で salonpack に変更すると、画面の「利用する機能」から予約通知を選べるようになる。
 * 料金・請求はこの CLI では扱わない(契約の確認は運営の手順で行う)。
 * 変更は salon_plan_changes に記録され、予約通知を含まない契約の間は停止期間として記録される(0022)。
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
  const [salon] = await sql<{ id: string; name: string; plan: string }[]>`select id, name, plan from public.salons where id = ${salonId}`;
  if (!salon) throw new Error("店舗が見つかりません。");
  console.log(`店舗 ${salon.id} ${salon.name} 現在の契約=${salon.plan}`);
  const history = await sql<{ changed_at: Date; old_plan: string | null; new_plan: string; changed_by: string; note: string | null }[]>`
    select changed_at, old_plan, new_plan, changed_by, note from public.salon_plan_changes where salon_id = ${salonId} order by changed_at`;
  for (const h of history) console.log(`  ${h.changed_at.toISOString()} ${h.old_plan} → ${h.new_plan} (${h.changed_by}) ${h.note ?? ""}`);
  if (command === "show") return;
  if (command !== "set-plan") throw new Error("show か set-plan を指定してください。");

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
    await tx`select set_config('salonpack.change_note', ${note}, true)`;
    await tx`update public.salons set plan = ${plan}, updated_at = now() where id = ${salonId}`;
  });
  console.log("契約を変更しました。お客様の「利用する機能」に反映されます(データ・Google連携は変わりません)。");
});
