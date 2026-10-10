import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import type { ScanLease, ScanStore } from "@/lib/notifications/mail/gmailScan";

// gmail_scan_state(0022)を使う ScanStore。リース(同時に同じ店舗を読まない)と、
// 続き(page token)・基準日時(watermark)の保存は DB 関数で行う。

export const dbScanStore: ScanStore = {
  async acquire({ salonId, accountId, initialWatermark }) {
    const { data, error } = await getNotificationsSupabaseAdmin().rpc("gmail_scan_acquire", {
      p_salon_id: salonId,
      p_account_id: accountId,
      p_initial_watermark: initialWatermark.toISOString(),
    });
    if (error) throw new Error("Gmail取得状況の確保に失敗しました。");
    const row = (data as Array<Record<string, string | null | boolean>> | null)?.[0];
    if (!row) return null;
    const lease: ScanLease = {
      leaseToken: row.lease_token as string,
      watermark: new Date(row.watermark as string),
      scanId: (row.scan_id as string | null) ?? null,
      scanStartedAt: row.scan_started_at ? new Date(row.scan_started_at as string) : null,
      pageToken: (row.page_token as string | null) ?? null,
    };
    return lease;
  },
  async progress(params) {
    const { data, error } = await getNotificationsSupabaseAdmin().rpc("gmail_scan_progress", {
      p_salon_id: params.salonId,
      p_lease_token: params.leaseToken,
      p_scan_id: params.scanId,
      p_scan_started_at: params.scanStartedAt?.toISOString() ?? null,
      p_page_token: params.pageToken,
      p_completed: params.completed,
      p_completed_watermark: params.completedWatermark?.toISOString() ?? null,
      p_release: params.release,
    });
    if (error) throw new Error("Gmail取得状況の保存に失敗しました。");
    return data === true;
  },
};
