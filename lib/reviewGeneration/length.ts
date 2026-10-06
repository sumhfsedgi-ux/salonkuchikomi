import type { Material } from "@/lib/reviewGeneration/materials";

/** 長さを補う再生成は、選択回答が豊富で本人の文体を優先する必要がない場合だけ。 */
export function hasRichChoices(materials: readonly Material[]): boolean {
  return !materials.some((m) => m.kind !== "choice") &&
    materials.filter((m) => m.role !== "visit" && m.role !== "discovery").length >= 4;
}

export function lengthGuidance(materials: readonly Material[]): string {
  const body = materials.filter((m) => m.role !== "visit" && m.role !== "discovery");
  const ownChars = body.filter((m) => m.kind !== "choice").reduce((n, m) => n + [...m.text].length, 0);
  if (ownChars >= 140) return "具体的な本人の文章が豊富。260〜350文字程度も許容。本人の長さ・口調を優先する。";
  if (body.length < 3) return "材料は少なめ。80〜170文字程度、少なければさらに短くてよい。水増ししない。";
  return "具体的な回答が十分ある。標準180〜260文字を目指す。80〜100文字の要約で終えず、来店の背景・メニュー、主役の具体的な良さ、店内などの補助、回答にある意向を2〜3段落で伝える。ただし新しい体験や重複で引き延ばさない。";
}
