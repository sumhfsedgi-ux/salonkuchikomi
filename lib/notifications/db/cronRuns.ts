import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// (hmailの lib/db/cronRuns.ts を移植。cron実行の開始/終了を記録する観測用
// テーブル -- 23節の切替手順で「直近の実行が完了しているか」の確認にも使う。)

export async function startCronRun(): Promise<string> {
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase.from("cron_runs").insert({}).select("id").single();

  if (error || !data) {
    console.error("startCronRun failed:", error);
    throw new Error("cron実行の記録開始に失敗しました。");
  }
  return data.id;
}

export async function finishCronRun(
  id: string,
  result: { salonsProcessed: number; salonsFailed: number; notes?: string }
): Promise<void> {
  const supabase = getNotificationsSupabaseAdmin();
  const { error } = await supabase
    .from("cron_runs")
    .update({
      finished_at: new Date().toISOString(),
      salons_processed: result.salonsProcessed,
      salons_failed: result.salonsFailed,
      notes: result.notes ?? null,
    })
    .eq("id", id);

  if (error) console.error("finishCronRun failed:", error);
}
