import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Memoized per request: without this, every Server Component/Action on a
// page independently calls createClient(), each one re-reading cookies()
// and producing its own client instance. Wrapping it in cache() means
// getCurrentSalon(supabase) (and anything else keyed on this client) can
// itself be memoized too, since all callers now share the same instance.
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component — the proxy is responsible for
            // refreshing the session cookie in that case, so this is safe to ignore.
          }
        },
      },
    },
  );
});
