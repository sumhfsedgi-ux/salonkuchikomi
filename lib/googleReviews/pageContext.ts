import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFeatureAccess } from "@/lib/access/featureAccess";
import { listSalonGoogleBindings } from "@/lib/google/db/bindings";
import { resolveGoogleReviewsAccess, type GoogleReviewsAccess } from "@/lib/googleReviews/access";
import type { GbpConnectionState } from "@/lib/googleReviews/types";

// 届いた口コミの画面(layout・一覧・詳細)が使う、1回のリクエストの中で共通の情報。
// 使えない店舗(準備中・許可が無い・契約外・利用開始待ち)は 404(入口を出さないうえで、直接の URL も通さない)。

export interface InboxPageContext {
  access: Extract<GoogleReviewsAccess, { ok: true }>;
  connection: GbpConnectionState;
  /** 予約メールで連携している Google アカウント(同じアカウントで口コミを連携する案内に使う)。 */
  gmailAccountEmail: string | null;
  /** 予約通知の Gmail を連携しているか(Gmail についての説明を、必要な店舗にだけ出す)。 */
  gmailConnected: boolean;
}

export const getInboxPageContext = cache(async (): Promise<InboxPageContext> => {
  const supabase = await createClient();
  await requireFeatureAccess(supabase, "google_reviews");
  const access = await resolveGoogleReviewsAccess();
  if (!access.ok) notFound();
  const [connection, bindings] = await Promise.all([access.inbox.getConnection(access.ctx), listSalonGoogleBindings(access.salon.id)]);
  const gmail = bindings.find((b) => b.feature === "gmail");
  const gbp = bindings.find((b) => b.feature === "gbp");
  return {
    access,
    connection,
    gmailAccountEmail: !gbp && gmail ? (gmail.accountEmail ?? gmail.account.email ?? null) : null,
    gmailConnected: Boolean(gmail),
  };
});
