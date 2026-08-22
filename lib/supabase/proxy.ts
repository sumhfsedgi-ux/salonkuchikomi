import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session cookie on every request, and gates
 * `/admin/**` (except `/admin/login`) behind an authenticated session.
 *
 * This is an *optimistic* check only: getClaims() verifies the JWT's
 * signature and expiry locally (via a cached JWKS, so it costs a network
 * round trip only the first time per server instance, not per request) —
 * it does not confirm the session hasn't been revoked server-side since the
 * token was issued. That's fine here because Proxy runs on every route
 * (per Next.js's own guidance, it should stick to cheap local checks, not
 * database/API round trips) and `app/admin/(authed)/layout.tsx` performs
 * the authoritative, server-verified check (`getUser()`) before any admin
 * data is ever read.
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
  const isAdminRoute = pathname.startsWith("/admin");
  const isLoginRoute = pathname === "/admin/login";

  if (isAdminRoute && !isLoginRoute && !data?.claims) {
    const loginUrl = new URL("/admin/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}
