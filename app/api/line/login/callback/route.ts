import { NextRequest, NextResponse } from "next/server";
import { getLineLoginDeps } from "@/lib/notifications/line/login/runtime";
import { BINDING_COOKIE, bindingHashOf, completeLineLogin } from "@/lib/notifications/line/login/flow";
import { continuePath } from "@/lib/notifications/line/login/messages";
import { logSafeError } from "@/lib/google/safeError";

// LINE ログインからの戻り先。結果はサーバーの記録(連携の進行)にだけ残し、どの結果でも固定の結果ページへ移る
// (URL に結果を載せない。任意の戻り先は受け付けない)。結果ページには、state に結び付いた進行の id だけを渡す
// (結果ページでも cookie と照合する)。state が無効(別のブラウザで開いた・期限切れ・再利用)なら、招待には触れない。
// code・トークンはログに出さない。

export async function GET(request: NextRequest) {
  const deps = getLineLoginDeps();
  let path = continuePath(null);
  if (deps) {
    const params = request.nextUrl.searchParams;
    try {
      const result = await completeLineLogin(
        {
          state: params.get("state"),
          code: params.get("code"),
          error: params.get("error"),
          bindingHash: bindingHashOf(request.cookies.get(BINDING_COOKIE)?.value),
        },
        deps
      );
      path =
        result.kind === "outcome"
          ? continuePath(result.flowId)
          : result.kind === "error"
            ? continuePath(result.flowId, "start_failed")
            : continuePath(result.flowId, result.flowId ? "expired" : "browser");
    } catch (error) {
      logSafeError("line/login callback", error);
      path = continuePath(null, "start_failed");
    }
  }
  const response = NextResponse.redirect(new URL(path, request.url), 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
