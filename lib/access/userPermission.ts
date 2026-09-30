import type { Feature } from "@/lib/appMode";

// 店舗内の個々のユーザーがその機能を使えるかどうかの軸。今回のスコープには
// 含まれない -- 「招待した個々のユーザーごとに口コミ/ブログ/予約通知の閲覧
// 範囲を変える」機能は将来の課題(owner/admin/staffロール、
// can_reviews/can_blog/can_notifications/can_settingsのようなsalon_members
// テーブルを想定)。
//
// 現行DBには1店舗1オーナー(salons.owner_id)しかなく、getCurrentSalon()が
// 「そのログインユーザー自身がownerであるsalon」しか返さない設計のため、
// この関数に辿り着けている時点で呼び出し主は常にそのsalonのowner本人であり、
// 今回は常にtrueを返してよい。
//
// 将来salon_membersを導入する際は、この関数の中身だけを実装すればよく、
// lib/access/featureAccess.tsやそれを呼ぶ各Page/Server Action/Route Handler
// 側の変更は不要にする。
export async function hasUserPermission(
  _userId: string,
  _salonId: string,
  _feature: Feature
): Promise<boolean> {
  return true;
}
