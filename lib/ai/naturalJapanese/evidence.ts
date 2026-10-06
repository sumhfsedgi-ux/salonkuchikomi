// 表記ゆれは同じ根拠として扱い、意向の種類・条件・否定は分ける。
import { foldSpelling, normalize } from "@/lib/ai/naturalJapanese/analyze";

export function canonicalEvidence(text: string): string {
  return foldSpelling(text)
    .replace(/instagram|インスタグラム|インスタ/giu, "instagram")
    .replace(/googleマップ|googlemaps|グーグルマップ/giu, "googlemaps")
    .replace(/理想どおり|理想通り|希望どおり|希望通り/gu, "理想通り");
}

export type IntentKind = "revisit" | "recommend" | "try_other";
const INTENTS: ReadonlyArray<readonly [IntentKind, RegExp]> = [
  ["try_other", /(?:別|他|ほか|違う).{0,10}(?:メニュー|施術|コース).{0,10}(?:試|受け|利用)|次は.{0,10}(?:試|受け)/u],
  ["recommend", /おすすめ|オススメ|お勧め|お薦め|すすめたい|勧めたい|紹介したい|紹介したく/u],
  ["revisit", /また(?:ぜひ)?(?:来|行|伺|お願い|利用|通|お世話|受け)|次も|次回も|リピート|通いたい|通い続け|続けたい|続けてみたい|通ってみたい/u],
];
const CAUTIOUS = /機会があれば|機会があったら|都合が|予定が合|様子を見|まだ|わからない|分からない|未定|検討|かもしれ|迷って/u;
const NEGATED = /(?:たく|するつもりは|する予定は|利用する予定は|行く予定は|来る予定は)ない|思わない|思いません|おすすめしない|勧めない|もう行かない|また行かない|また来ない/u;
const COMMITTED = /絶対|必ず|定期的|通い続け|一生/u;

export function intentKinds(text: string): IntentKind[] {
  const value = normalize(text);
  return INTENTS.filter(([, pattern]) => pattern.test(value)).map(([kind]) => kind);
}

/** true はコードだけで安全に同じ意向と言える範囲。それ以外は意味検証へ。 */
export function assessIntent(text: string, evidence: readonly string[]): "none" | "supported" | "risk" | "unsupported" {
  const kinds = intentKinds(text);
  if (!kinds.length) return "none";
  let risk = false;
  for (const kind of kinds) {
    const matching = evidence.filter((source) => intentKinds(source).includes(kind));
    if (!matching.length) return "unsupported";
    // 肯定・否定や条件付き意向は単純な単語一致では判断しない。
    if (!matching.some((source) => !CAUTIOUS.test(source) && !NEGATED.test(source)) ||
        CAUTIOUS.test(text) || NEGATED.test(text) ||
        (COMMITTED.test(text) && !matching.some((source) => COMMITTED.test(source)))) risk = true;
  }
  return risk ? "risk" : "supported";
}

export function hasNegativeIntent(text: string): boolean {
  return NEGATED.test(normalize(text));
}

/** 表示と評価で共有。改行以外は正規化せず、空白・句読点も数える。 */
export function reviewCharacterCount(text: string): number {
  return [...text.replace(/[\r\n]/g, "")].length;
}
