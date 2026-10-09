import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { completeGoogleConnect } from "@/lib/google/oauthFlow";
import type { OAuthReturnTo } from "@/lib/google/db/oauthStates";
import { getGoogleFlowDeps } from "@/lib/google/runtime";
import { logSafeError } from "@/lib/google/safeError";

// Google からの戻り先。ユーザーと店舗は今のセッションから解決し、state に結び付いたユーザー・店舗と
// 一致しなければ(途中でログアウト・別ユーザー・別店舗に切り替わった)何も保存しない。
// 認可コード・トークンはログに出さない。予約通知の運用状態はここでは変えない。

const RETURN_PATHS: Record<OAuthReturnTo, string> = {
  settings_google: "/dashboard/settings/google",
  dashboard: "/dashboard",
  notifications: "/dashboard/notifications",
};

function redirectTo(request: NextRequest, path: string, params: Record<string, string>): NextResponse {
  const url = new URL(path, request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const salon = user ? await getCurrentSalon(supabase) : null;
  if (!user || !salon) {
    return redirectTo(request, "/login", {});
  }

  const params = request.nextUrl.searchParams;
  try {
    const result = await completeGoogleConnect(
      {
        salonId: salon.id,
        userId: user.id,
        stateParam: params.get("state"),
        code: params.get("code"),
        oauthError: params.get("error"),
      },
      getGoogleFlowDeps()
    );
    if (result.status === "retry") return NextResponse.redirect(result.url, 303);
    if (result.status === "failed") return redirectTo(request, RETURN_PATHS[result.returnTo], { google: result.reason });
    return redirectTo(request, RETURN_PATHS[result.returnTo], {
      google: "connected",
      ...(result.missing.length > 0 ? { missing: result.missing.join(",") } : {}),
    });
  } catch (error) {
    logSafeError("google/callback", error);
    return redirectTo(request, RETURN_PATHS.settings_google, { google: "failed" });
  }
}
