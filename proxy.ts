import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export function proxy(request: NextRequest) {
  return updateSession(request);
}

// /api/generate-review(お客様ページから呼ぶ公開の API)は対象にしない。ログインを必要とせず、
// 読み取りの client(lib/supabase/server.ts)が自分で cookie を読み、期限切れなら自分で更新する。
// cookie の有無・期限切れ・壊れた cookie で、状態コード・応答・返す cookie が Proxy を通したときと
// 同じことを、検証専用の DB で確かめてから外した。
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|review|api/generate-review|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
