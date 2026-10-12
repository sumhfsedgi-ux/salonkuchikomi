import type { OverrideMode } from "@/lib/features/entitlements";

// 管理画面のスイッチ(利用中/停止)と、DB に保存する個別設定(プランに従う=inherit / 個別に許可=allow /
// 個別に利用不可=deny)の対応(DBに触れない)。画面は2択にし、保存する値は今まで通り3つのどれかにする。
//   - プランの標準で使える機能: 利用中 = inherit、停止 = deny
//   - プランの標準では使えない機能(将来): 利用中 = allow、停止 = inherit
// 対象プランの外・準備中・提供終了の制限は、スイッチでは解除しない(画面ではスイッチを押せなくする。DB も拒否する)。

/** その設定が「利用中」の側か(対象プラン・提供状態の制限は別に見る)。 */
export function isSwitchOn(override: OverrideMode, defaultOn: boolean): boolean {
  if (override === "allow") return true;
  if (override === "deny") return false;
  return defaultOn;
}

/**
 * スイッチを on/off にしたときに保存する個別設定。保存済みの設定と同じ側に戻したときは保存済みの値に戻す
 * (押して戻しただけで変更を作らない)。それ以外は、標準と同じ側を「プランに従う」にする。
 */
export function overrideForSwitch(on: boolean, defaultOn: boolean, saved: OverrideMode): OverrideMode {
  if (isSwitchOn(saved, defaultOn) === on) return saved;
  if (on === defaultOn) return "inherit";
  return on ? "allow" : "deny";
}
