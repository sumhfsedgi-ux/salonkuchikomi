import { NextRequest, NextResponse } from "next/server";
import { isLineInviteAvailable } from "@/lib/notifications/line/login/config";
import { BINDING_COOKIE, BINDING_COOKIE_MAX_AGE_SECONDS, bindingHashOf, newBindingValue, openInvite } from "@/lib/notifications/line/login/flow";
import { logSafeError } from "@/lib/google/safeError";

// 招待のリンクを開いたとき、ページがフラグメントから読み取った招待の値を、POST の本文で一度だけ受け取る
// (値は URL に載せないので、アクセスログに残らない。ログにも出さない)。
// 有効なら、このブラウザとの結び付け(httpOnly の cookie)と連携の進行を作り、進行の id・店舗名・表示名だけを返す
// (画面はこの id で連携を始める。id は cookie と組でなければ使えない)。
// 既存の通知先・予約の情報は返さない。ログインは不要で、管理画面の権限は与えない。

export async function POST(request: NextRequest) {
  if (!isLineInviteAvailable()) return NextResponse.json({ status: "unavailable" });
  let token: unknown;
  try {
    token = ((await request.json()) as { token?: unknown }).token;
  } catch {
    return NextResponse.json({ status: "not_found" });
  }
  const existing = request.cookies.get(BINDING_COOKIE)?.value;
  const bindingValue = bindingHashOf(existing) ? existing! : newBindingValue();
  try {
    const opened = await openInvite(token, bindingHashOf(bindingValue)!);
    const response = NextResponse.json(opened);
    response.headers.set("Cache-Control", "no-store");
    if (opened.status === "valid") {
      response.cookies.set(BINDING_COOKIE, bindingValue, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: BINDING_COOKIE_MAX_AGE_SECONDS,
      });
    }
    return response;
  } catch (error) {
    logSafeError("line/invite open", error);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
