import { getNotificationsSupabaseAdmin as getServiceRoleClient } from "@/lib/notifications/admin";
import { logSafeError, summarizeError } from "@/lib/google/safeError";
import { openSecret, refreshTokenAad } from "@/lib/google/tokenBox";
import type { GoogleOAuthTransport } from "@/lib/google/transport";

// 「Google連携をすべて解除」で、どの店舗・機能からも参照されなくなったアカウントの認可を Google で取り消す。
// ジョブは DB 側(google_begin_revocation)で、取り消し待ちのまま・世代が一致・参照ゼロであることを
// 確かめてから取り出す。その後に再接続されたアカウントの新しい認可は取り消さない。

interface RevocationRow {
  id: string;
  google_account_id: string;
  token_generation: number;
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  refresh_token_tag: string;
  key_version: string;
}

export async function processGoogleRevocations(
  deps: { transport: GoogleOAuthTransport },
  limit = 5
): Promise<{ revoked: number; failed: number }> {
  const supabase = getServiceRoleClient();
  let revoked = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const { data, error } = await supabase.rpc("google_begin_revocation", {});
    if (error) {
      logSafeError("google/revocation begin", error);
      break;
    }
    const job = (data as RevocationRow[] | null)?.[0];
    if (!job) break;
    let ok = false;
    let reason: string | null = null;
    try {
      const token = openSecret(
        { ciphertext: job.refresh_token_ciphertext, iv: job.refresh_token_iv, tag: job.refresh_token_tag, keyVersion: job.key_version },
        refreshTokenAad(job.google_account_id, job.token_generation)
      );
      await deps.transport.revokeToken(token);
      ok = true;
    } catch (err) {
      const summary = summarizeError(err);
      reason = `${summary.name}:${summary.reason ?? summary.status ?? "unknown"}`;
    }
    await supabase.rpc("google_finish_revocation", { p_id: job.id, p_ok: ok, p_error: reason });
    if (ok) revoked++;
    else failed++;
  }
  return { revoked, failed };
}
