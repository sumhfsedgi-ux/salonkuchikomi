import { bigramOverlap, findPhrases } from "@/lib/ai/naturalJapanese/analyze";
import { assessIntent, canonicalEvidence } from "@/lib/ai/naturalJapanese/evidence";
import type { Material } from "@/lib/reviewGeneration/materials";
import { appealCategoriesOf } from "@/lib/reviewGeneration/appeal";

/** IDの自己申告だけで「反映済み」にしない。確信できない言い換えは修正候補にする。
 * 事実検証とは独立した品質の目安。これだけを理由に文を削除しない。
 */
export function missingEvidence(
  materials: readonly Material[], ids: readonly string[],
  sentences: ReadonlyArray<{text: string; sourceIds: string[]}>,
): string[] {
  return ids.filter((id) => {
    const material = materials.find((m) => m.id === id);
    if (!material) return false;
    const cited = sentences.filter((s) => s.sourceIds.includes(id));
    return !cited.some((sentence) => {
      if (material.intent) {
        // 条件付き・否定的意向は語の重なりも必要。単なる満足表現では充足しない。
        const intent = assessIntent(sentence.text, [material.text]);
        if (intent === "supported") return true;
        if (intent !== "risk") return false;
      }
      const categories = appealCategoriesOf(material.text);
      const retainsTopic = categories.length > 0 && categories.every((c) => appealCategoriesOf(sentence.text).includes(c));
      // 「肌に合った提案」→「肌の状態に合わせて提案」のような語順の違いも扱う。
      const anchors = findPhrases(material.text, ["提案", "カウンセリング", "説明", "清潔", "理想通り", "デザイン", "しっとり", "話しやす"]);
      return bigramOverlap(canonicalEvidence(material.text), canonicalEvidence(sentence.text)) >= 0.45 ||
        (retainsTopic && anchors.length > 0 && anchors.every((a) => canonicalEvidence(sentence.text).includes(canonicalEvidence(a))));
    });
  });
}
