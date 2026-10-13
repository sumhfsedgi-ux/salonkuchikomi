// お客様用ページの完全なURL(運営管理の「開く」「URLをコピー」用。DBに触れない)。
// 本番のドメインを固定せず、いま開いている環境(リクエストのホスト)から作る。

type HeaderReader = { get(name: string): string | null };

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** リクエストの送り先(プロキシ経由なら x-forwarded-*)。ホストが分からなければ null。 */
export function requestOrigin(headers: HeaderReader): string | null {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0].trim();
  if (!host) return null;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0].trim() || (LOCAL_HOST.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

export function customerPageUrl(origin: string, slug: string): string {
  return `${origin}/review/${encodeURIComponent(slug)}`;
}
