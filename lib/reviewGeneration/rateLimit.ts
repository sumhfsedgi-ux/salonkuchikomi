import "server-only";
import { createHash, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// 口コミ生成のレート制限(docs/plans/reviews-465-plan.md §13。0012 の rate_limit_hit を使う)。
//   IP + 店舗: 10分に20回(店内Wi-Fiで複数のお客様が同じIPになる・再生成がある、ため緩め)
//   店舗     : 1日に300回
// 上限は環境変数で変えられる。DB のエラー(0012 の適用前を含む)のときは、お客様の
// 生成を止めないよう通す(ログには種類だけを残す)。生の IP アドレスは保存せず、ハッシュにする。

const IP_SALON_WINDOW_SECONDS = 10 * 60;
const SALON_WINDOW_SECONDS = 24 * 60 * 60;
const DEFAULT_IP_SALON_LIMIT = 20;
const DEFAULT_SALON_DAILY_LIMIT = 300;

function readLimit(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function generationRateLimits() {
  return {
    ipSalonPer10Min: readLimit("REVIEW_RATE_LIMIT_IP_SALON_PER_10MIN", DEFAULT_IP_SALON_LIMIT),
    salonPerDay: readLimit("REVIEW_RATE_LIMIT_SALON_PER_DAY", DEFAULT_SALON_DAILY_LIMIT),
  };
}

/** Vercel が付けるヘッダーからお客様の IP を取る。分からなければ null。 */
export function clientIp(request: Request): string | null {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

/** IP をそのまま保存しないためのハッシュ(鍵があれば HMAC)。 */
export function hashIp(ip: string): string {
  const secret = process.env.RATE_LIMIT_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const digest = secret ? createHmac("sha256", secret).update(ip) : createHash("sha256").update(ip);
  return digest.digest("hex").slice(0, 32);
}

async function hit(
  admin: SupabaseClient,
  key: string,
  windowSeconds: number,
  limit: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc("rate_limit_hit", {
    p_key: key,
    p_window_seconds: windowSeconds,
    p_limit: limit,
  });
  if (error) {
    console.warn("rate_limit_hit failed; allowing the request", { code: error.code });
    return true;
  }
  return data !== false;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; scope: "ip_salon" | "salon_daily" };

export async function checkGenerationRateLimit(
  admin: SupabaseClient,
  params: { salonId: string; ip: string | null },
): Promise<RateLimitDecision> {
  const limits = generationRateLimits();
  if (params.ip) {
    const key = `rg:ip:${hashIp(params.ip)}:${params.salonId}`;
    if (!(await hit(admin, key, IP_SALON_WINDOW_SECONDS, limits.ipSalonPer10Min))) {
      // IP の上限に当たったリクエストは、店舗の1日の回数には数えない。
      return { allowed: false, scope: "ip_salon" };
    }
  }
  if (!(await hit(admin, `rg:salon:${params.salonId}`, SALON_WINDOW_SECONDS, limits.salonPerDay))) {
    return { allowed: false, scope: "salon_daily" };
  }
  return { allowed: true };
}

/** CTA クリックの記録用(1つの IP から10分に60回まで)。 */
export async function checkEventRateLimit(admin: SupabaseClient, ip: string | null): Promise<boolean> {
  if (!ip) return true;
  return hit(admin, `re:ip:${hashIp(ip)}`, IP_SALON_WINDOW_SECONDS, 60);
}
