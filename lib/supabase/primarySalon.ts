// ログイン中のオーナーが「いま操作している店舗」を決めるための純粋関数群
// (getCurrentSalon から使う。DBアクセスを含まないので単体テストできる)。
//
// salons.owner_id には unique 制約を付けていない。将来の1オーナー複数店舗・
// salon_members への拡張を妨げないためで、「1オーナー1店舗」は現在の商品ルールとして
// アプリ側(createSalonAction)で担保している(docs/plans/reviews-465-plan.md §5)。

/**
 * PostgREST の embedding は、FK 側に unique 制約があれば1対1とみなしてオブジェクトを、
 * 無ければ配列を返す。どちらの形でも同じように扱えるよう配列にそろえる。
 */
export function toRowArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

interface SalonOrderKey {
  id: string;
  created_at: string;
}

function compareSalonRows(a: SalonOrderKey, b: SalonOrderKey): number {
  const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (Number.isFinite(diff) && diff !== 0) return diff;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * 店舗が複数ある場合でも毎回同じ店舗を選ぶ(最も古い店舗。作成日時が同じならid順)。
 * PostgREST の embedding は並び順を保証しないため、呼び出しごとに別の店舗が
 * 選ばれて新しいテーブルの salon_id が揺れることを防ぐ。
 */
export function pickPrimarySalon<T extends SalonOrderKey>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort(compareSalonRows)[0];
}
