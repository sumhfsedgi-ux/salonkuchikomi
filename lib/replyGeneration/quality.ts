import { countChars } from "@/lib/ai/naturalJapanese/analyze";
import type { ReplyMode } from "@/lib/replyGeneration/classify";
import { REPLY_LENGTH_TARGETS, type ReplySettings } from "@/lib/replyGeneration/settings";

// 語彙ベースの補助検査。意味・事実の網羅的な検証ではない。
// 返信の責任や対応を確定せず、口コミにある重要な話題を消さないために使う。
export const CONCERN_TOPICS = [
  { name: "待ち時間", source: /待ち時間|待たされ|待った|wait(?:ed|ing)?|delay/i, reply: /待|時間|wait|delay/i },
  { name: "説明・案内", source: /説明|案内|explan|informed/i, reply: /説明|案内|伝|explan|inform/i },
  { name: "料金", source: /料金|会計|金額|price|charg|bill/i, reply: /料金|会計|金額|支払|price|charg|bill|cost/i },
  { name: "返金の要望", source: /返金|お金を返|refund/i, reply: /返金|お金|返還|refund/i },
  { name: "施術後・施術中の体の状態", source: /赤く|赤み|ヒリヒリ|痛|腫|かぶれ|けが|怪我|火傷|やけど|rash|burn|pain|hurt|skin.{0,15}red/i, reply: /赤|肌|皮膚|ヒリヒリ|痛|腫|かぶれ|けが|怪我|火傷|やけど|rash|burn|pain|hurt|skin/i },
  { name: "治療費の要望", source: /治療費|medical (?:cost|bill|expense)/i, reply: /治療費|費用|medical (?:cost|bill|expense)/i },
  { name: "衛生", source: /不衛生|汚れ|汚い|dirty|unhygienic/i, reply: /衛生|清潔|タオル|汚|clean|hygien|towel|dirty/i },
  { name: "接客", source: /態度|暴言|怒鳴|対応.{0,8}(?:冷|失礼)|rude|attitude/i, reply: /態度|接客|対応|言動|言葉|staff|service|rude|attitude/i },
  { name: "予約", source: /予約.{0,12}(?:取|難)|book.{0,15}(?:hard|difficult)|hard.{0,15}book/i, reply: /予約|book|appointment/i },
  { name: "駐車場", source: /駐車|停め|parking/i, reply: /駐車|停め|parking/i },
  { name: "仕上がり", source: /仕上がり|仕上り|result|finish/i, reply: /仕上|イメージ|result|finish|expectation/i },
] as const;

export type ReplyLanguage = "ja" | "en";
/** 現在の自動検査の対応範囲は日本語と、英語と明確に判断できる本文。その他は日本語。 */
export function replyLanguage(text: string): ReplyLanguage {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)) return "ja";
  return /\b(?:the|and|was|were|very|staff|massage|recommend|service|thanks|thank|great|good|bad|waited|refund)\b/i.test(text) ? "en" : "ja";
}

export function replyLengthTarget(mode: ReplyMode, settings: ReplySettings, language: ReplyLanguage = "ja") {
  const base = language === "en"
    ? { short: { min: 25, max: 45 }, normal: { min: 45, max: 85 }, long: { min: 85, max: 150 } }[settings.length]
    : REPLY_LENGTH_TARGETS[settings.length];
  if (mode === "thanks_only") return { min: language === "en" ? 8 : 20, max: Math.min(base.max, language === "en" ? 35 : 80) };
  return base;
}

export function replyLength(text: string, language: ReplyLanguage): number {
  return language === "en" ? (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length : countChars(text);
}

export function missingConcerns(review: string, reply: string, mode: ReplyMode): string[] {
  if (mode !== "careful" && mode !== "mixed") return [];
  return CONCERN_TOPICS.filter((topic) => topic.source.test(review) && !topic.reply.test(reply)).map((topic) => topic.name);
}

export interface QualityContext {
  reviewText: string;
  mode: ReplyMode;
  settings: ReplySettings;
}

/** 長さは設定上の目安。修正しても外れる場合は警告し、本文を機械的に切らない。 */
export function replyLengthProblems(reply: string, context: QualityContext): string[] {
  const problems: string[] = [];
  const { reviewText, mode, settings } = context;
  const language = replyLanguage(reviewText);
  const target = replyLengthTarget(mode, settings, language);
  const actualLength = replyLength(reply, language);
  if (actualLength > target.max) problems.push(`現在の本文は${actualLength}${language === "en" ? "語" : "文字"}で設定の長さを超えています。${Math.round((target.min + target.max) / 2)}${language === "en" ? "語" : "文字"}程度を目標に短くし、上限${target.max}以内にする。重要な訴えを削らず、途中で切らない。`);
  if (settings.length === "long" && mode !== "thanks_only" && actualLength < target.min) problems.push(`詳しくの設定に対して本文が短すぎます。${target.min}〜${target.max}${language === "en" ? "語" : "文字"}を目安に、原文にある内容への応答を丁寧にする。事実や対応は足さない。`);
  return problems;
}

/** 修正後にも実行する。引用は根拠の一部であり、返信全体の事実性を保証しない。 */
export function replyQualityProblems(reply: string, context: QualityContext, quotes: unknown = []): string[] {
  const problems: string[] = [];
  const { reviewText, mode } = context;
  const language = replyLanguage(reviewText);
  if (/今後の参考に/.test(reply)) problems.push("『今後の参考に』の定型句を使わず、具体的な内容への受け止めで結ぶ。重要な訴えへの応答を消さない。");
  if (/ご気になる/.test(reply)) problems.push("『ご気になる』は不自然です。『気になる』『お気になる』のように自然な敬語に直す。");
  if (language === "en" && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(reply)) problems.push("この口コミへの返信本文は英語で書く。署名・連絡先は別処理なので書かない。");
  for (const topic of missingConcerns(reviewText, reply, mode)) problems.push(`口コミの「${topic}」への応答がありません。一般的なお礼・期待・不快感だけに置き換えず、書かれた内容に触れる。原因や対応は断定しない。`);
  if (!reviewText.trim() && /口コミを書|ご意見|お話|施術|スタッフ|feedback|treatment|staff/i.test(reply)) problems.push("本文のない評価です。書かれていない意見や出来事に触れず、評価へのお礼として書く。");
  if (/(?:お二人|二人|2人|two of you|both of you)/i.test(reply) && !/(?:二人|2人|two of us|both of us)/i.test(reviewText)) problems.push("人数の根拠がありません。友人と来店しただけでは二人と決めない。");
  if (/笑顔|smil(?:e|es|ing)/i.test(reply) && !/笑顔|smil(?:e|es|ing)/i.test(reviewText)) problems.push("口コミにない笑顔を見た体験を作らない。");
  if (/覚えております|覚えています|remember (?:you|your)|お話しした|お話した/i.test(reply) && !/覚えて|話し|話した|remember|talked/i.test(reviewText)) problems.push("口コミに根拠のない記憶や会話を作らない。");
  if (Array.isArray(quotes)) {
    for (const entry of quotes) {
      const quote = typeof entry === "object" && entry !== null && "quote" in entry ? (entry as { quote: unknown }).quote : null;
      if (typeof quote !== "string" || !quote.trim() || !reviewText.includes(quote)) {
        problems.push("respond_to の引用が口コミ本文に存在しません。実在する短い引用だけを使い、本文なしでは空配列にする。");
        break;
      }
    }
  }
  return problems;
}
