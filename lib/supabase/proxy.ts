import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { loginPathFor, RETURN_COOKIE, RETURN_COOKIE_MAX_AGE_SECONDS, safeReturnPath } from "@/lib/auth/returnPath";

/**
 * Refreshes the Supabase auth session cookie on every request, and gates
 * `/dashboard/**` behind an authenticated session. `/login`,
 * `/forgot-password`, `/reset-password`, `/privacy` and the legacy `/admin/**`
 * redirect stubs (see app/admin/) are intentionally left unguarded -- the
 * first three are the public auth screens themselves, `/privacy` is the
 * public privacy policy (registered with Google, so it must open without
 * login), and the stubs only ever call redirect() and read nothing sensitive.
 *
 * This is an *optimistic* check only: getClaims() verifies the JWT's
 * signature and expiry locally (via a cached JWKS, so it costs a network
 * round trip only the first time per server instance, not per request) —
 * it does not confirm the session hasn't been revoked server-side since the
 * token was issued. That's fine here because Proxy runs on every route
 * (per Next.js's own guidance, it should stick to cheap local checks, not
 * database/API round trips) and `app/dashboard/layout.tsx` performs
 * the authoritative, server-verified check (`getUser()`) before any
 * dashboard data is ever read.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();

  const { pathname } = request.nextUrl;
  // ログインが必要な画面(店舗の画面・店舗の登録と利用開始待ち・本人確認)。/signup・/auth/confirm は公開のまま。
  const requiresLogin = ["/dashboard", "/onboarding", "/auth/verify"].some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (requiresLogin && !data?.claims) {
    // 口コミ詳細(LINE の通知のリンク)だけは、ログインのあとに戻れるよう戻り先を持たせる(lib/auth/returnPath.ts)。
    // クエリ付きなど形の違う URL は戻り先にしない。
    const returnPath = request.nextUrl.search ? null : safeReturnPath(pathname);
    const redirect = NextResponse.redirect(new URL(loginPathFor(returnPath), request.url));
    if (returnPath) {
      redirect.cookies.set(RETURN_COOKIE, returnPath, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: RETURN_COOKIE_MAX_AGE_SECONDS,
      });
    }
    return redirect;
  }

  return response;
}
