import { findPhrases, foldSpelling, normalize, splitSentences } from "@/lib/ai/naturalJapanese/analyze";
import { MEDICAL_PHRASES } from "@/lib/ai/naturalJapanese/phrases";
import type { ReplyMode } from "@/lib/replyGeneration/classify";
import { REPLY_MAX_BYTES, utf8Bytes } from "@/lib/replyGeneration/text";

// 返信の下書きを決定的に検査する(docs/plans/google-reviews-inbox-plan.md §9-2)。
//   block : 投稿させてはいけない内容(補償の約束・責任の全面的な承認・改善の断定・反論・
//           連絡先や宣伝・医療的な表現・口コミに無い来店の事実・慎重モードでの再来店の誘い・長すぎ)。
//           その文を削るか、1回だけ LLM に直させる(pipeline.ts)。
//   review: 投稿前に人が確かめるべき点。画面に「投稿前にご確認ください」として出す。
//   style : 記録だけ(画面には出さない)。
// 語彙の外の言い換えは見逃すので、オフライン評価(scripts/eval/reply-generation.eval.ts)で監視する。

export type ReplyLintSeverity = "block" | "review" | "style";

export type ReplyLintCode =
  | "compensation"
  | "liability_admission"
  | "causal_admission"
  | "incident_admission"
  | "improvement_claim"
  | "rebuttal"
  | "contact_or_promo"
  | "medical"
  | "invented_visit_fact"
  | "revisit_in_careful"
  | "too_long_bytes"
  | "unsupported_number"
  | "over_apology"
  | "decoration";

export interface ReplyLintIssue {
  code: ReplyLintCode;
  severity: ReplyLintSeverity;
  /** 該当する文の位置(toSentences の順)。文書全体の指摘なら null。 */
  sentenceIndex: number | null;
}

export interface ReplySentence {
  text: string;
  /** 元の返信の何行目(段落)にあったか。文を削ったあと改行を保って組み立て直すために使う。 */
  line: number;
}

/** 返信を文に分ける(段落=改行の位置を覚えておく)。 */
export function toSentences(reply: string): ReplySentence[] {
  const result: ReplySentence[] = [];
  reply.split(/\r?\n/).forEach((line, lineIndex) => {
    for (const sentence of splitSentences(line)) result.push({ text: sentence, line: lineIndex });
  });
  return result;
}

/** 文を組み立て直す。同じ段落の文は続けて書き、段落は改行1つで区切る。 */
export function joinSentences(sentences: readonly ReplySentence[]): string {
  const lines: string[] = [];
  let currentLine: number | null = null;
  for (const sentence of sentences) {
    if (sentence.line !== currentLine) {
      lines.push(sentence.text);
      currentLine = sentence.line;
    } else {
      lines[lines.length - 1] += sentence.text;
    }
  }
  return lines.join("\n");
}

const BLOCK_PATTERNS: readonly (readonly [ReplyLintCode, RegExp])[] = [
  [
    "compensation",
    /返金|全額|無料(で|に|にて|とさせ|対応)|無償|割引(いたし|させ|します)|半額|お詫びの(品|印|しるし)|補償|賠償|弁償|次回.{0,10}(サービス|無料|割引|お安く|半額)|代金.{0,6}(いただきません|お返し)/u,
  ],
  [
    "liability_admission",
    /当店の(過失|落ち度)|当店の責任(?!者)|全面的に|すべて(当店|私ども|わたくしども|弊店|こちら)の(責任|せい|落ち度)|責任を(持って|もって)(補償|対応|賠償)|非を認め/u,
  ],
  [
    "improvement_claim",
    /(改善|是正|修正)(いたしました|しました|させました|済み|を完了)|徹底(いたしました|しました|させました|いたします)|二度と(起こ|ござい|いたし|させ|ない)|再発防止(策を|を徹底|に努めました)|必ず(改善|直)|今後は(一切|絶対)/u,
  ],
  [
    "rebuttal",
    /そのような(事実|こと)(は|も)?(ございません|ありません|ない)|事実(と|とは)異な|誤解(です|でございます|かと|があるよう|をされ)|おっしゃいますが|とのことですが.{0,20}(実際|当店では|規定)|規定(により|どおり|通り)|ご理解(ください|いただきたく|いただけますと)/u,
  ],
  [
    "contact_or_promo",
    /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|0\d{1,4}[-‐ー−]?\d{1,4}[-‐ー−]?\d{3,4}|LINE\s*ID|クーポン|キャンペーン|ポイント(還元|プレゼント|付与)|特典|お得(な|に)/iu,
  ],
];

// 口コミに書かれていないのに書くと「来店の事実の捏造」になる語。口コミにあれば使ってよい。
const VISIT_FACT_PHRASES = [
  "いつも",
  "毎回",
  "何度も",
  "久しぶり",
  "久々",
  "初めて",
  "はじめて",
  "リピート",
  "前回",
  "以前にも",
  "長年",
  "常連",
];

// 「スタッフの態度によりご不快な思いをさせてしまい」のように、口コミの出来事を原因として認める書き方。
// 謝罪の文そのものなので、削らずに直させる(REPAIR_FIRST_CODES)。
// 「回数券の勧誘でご不快な思いをさせてしまい」「〜についてご不快な思いをさせてしまい」のように、
// 具体的な出来事に結び付けて「させてしまった」と書くのも同じ扱い。出来事に結び付けない
// 「ご不快な思いをさせてしまい申し訳ございません」は、気持ちへのお詫びとして問題にしない。
const CAUSAL_ADMISSION_PATTERNS = [
  /(により|によって|のせいで|が原因で|のために)、?(お客様に)?(ご不快|ご迷惑|ご不便|嫌な思い|つらい思い|痛い思い|不安な思い)/u,
  /(で|について|につきまして|に関して|に関しまして|の件で)[^。]{0,12}?(ご不快な思い|嫌な思い|つらい思い|痛い思い|不安な思い|ご不便|ご迷惑)を(させ|おかけ)/u,
];

// 口コミに書かれた出来事を、店舗が「したこと」として認める書き方
// (「お待たせしてしまい」「説明が不足しており」「予約を変更してしまい」「当店の不手際」など)。
// 「お待ちいただいたとのこと」「説明が分かりにくかったとのこと」のような受け止めは当たらないよう、
// 直後が「とのこと」「と感じ」などのときは除く。
const INCIDENT_ADMISSION_PATTERNS = [
  /お待たせ(して|いたして)?(しまい|しまっ|いたしまし|しまし|いたし|し)(?!.{0,4}(とのこと|と感じ|とお感じ))/u,
  /(説明|案内|連絡|確認)(が|も|の)?(不足|不十分|足りず|足りな|行き届かず|行き届いておらず|行き届かな)(?!.{0,6}(とのこと|と感じ|とお感じ|という|との))/u,
  /(遅れて|遅くなって|変更して|忘れて|間違えて|失念して|伝え漏れて)(しまい|しまっ|おり)/u,
  /不手際|手違い|(当店|こちら|スタッフ|担当者?)の(ミス|落ち度|不注意)|配慮(が足りず|が足りなかった|不足)/u,
];

/** 削ると返信の中心(お詫びの文)が無くなるので、削る前に LLM に直させる指摘。 */
export const REPAIR_FIRST_CODES: ReadonlySet<ReplyLintCode> = new Set<ReplyLintCode>([
  "causal_admission",
  "incident_admission",
]);

const REVISIT_PATTERN = /またの(ご来店|ご利用|お越し)|また(お|ご)?(越し|来店|待ち)|ぜひまた|またぜひ|再来店|お待ちしております|お待ちしています/u;
const APOLOGY_PATTERN = /申し訳|お詫び|おわび|すみません|失礼いたしました/gu;
const DECORATION_PATTERN = /\p{Extended_Pictographic}|♪|☆|✨|[!！]{2,}/u;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** 口コミに出てこない数字を返す(★の数そのものは除く)。全角は半角にそろえて比べる。 */
function unsupportedNumbers(sentence: string, reviewText: string, rating: number): string[] {
  const numbers = normalize(sentence).match(/\d+/g) ?? [];
  const review = normalize(reviewText);
  return numbers.filter((n) => n !== String(rating) && !review.includes(n));
}

export interface ReplyLintContext {
  reviewText: string;
  rating: number;
  mode: ReplyMode;
}

export function lintReply(reply: string, context: ReplyLintContext): ReplyLintIssue[] {
  const issues: ReplyLintIssue[] = [];
  const sentences = toSentences(reply);
  const foldedReview = foldSpelling(context.reviewText);

  sentences.forEach((sentence, index) => {
    const text = normalize(sentence.text);
    for (const [code, pattern] of BLOCK_PATTERNS) {
      if (pattern.test(text)) issues.push({ code, severity: "block", sentenceIndex: index });
    }
    const medical = findPhrases(sentence.text, MEDICAL_PHRASES).filter(
      (phrase) => !foldedReview.includes(foldSpelling(phrase)),
    );
    if (medical.length > 0) issues.push({ code: "medical", severity: "block", sentenceIndex: index });

    const visitFacts = findPhrases(sentence.text, VISIT_FACT_PHRASES).filter(
      (phrase) => !foldedReview.includes(foldSpelling(phrase)),
    );
    if (visitFacts.length > 0) issues.push({ code: "invented_visit_fact", severity: "block", sentenceIndex: index });

    if (
      (context.mode === "careful" || context.mode === "mixed") &&
      CAUSAL_ADMISSION_PATTERNS.some((pattern) => pattern.test(text))
    ) {
      issues.push({ code: "causal_admission", severity: "block", sentenceIndex: index });
    }
    if (
      (context.mode === "careful" || context.mode === "mixed") &&
      INCIDENT_ADMISSION_PATTERNS.some((pattern) => pattern.test(text))
    ) {
      issues.push({ code: "incident_admission", severity: "block", sentenceIndex: index });
    }
    if (context.mode === "careful" && REVISIT_PATTERN.test(text)) {
      issues.push({ code: "revisit_in_careful", severity: "block", sentenceIndex: index });
    }
    if (unsupportedNumbers(sentence.text, context.reviewText, context.rating).length > 0) {
      issues.push({ code: "unsupported_number", severity: "review", sentenceIndex: index });
    }
    if (DECORATION_PATTERN.test(sentence.text)) {
      issues.push({ code: "decoration", severity: "style", sentenceIndex: index });
    }
  });

  if (utf8Bytes(reply) > REPLY_MAX_BYTES) issues.push({ code: "too_long_bytes", severity: "block", sentenceIndex: null });
  if (countMatches(reply, APOLOGY_PATTERN) >= 3) issues.push({ code: "over_apology", severity: "review", sentenceIndex: null });

  return issues;
}

export function blockingIssues(issues: readonly ReplyLintIssue[]): ReplyLintIssue[] {
  return issues.filter((issue) => issue.severity === "block");
}

/** LLM に直させるときに伝える問題の説明(文の内容は含めない。コードの説明だけ)。 */
export const REPAIR_HINTS: Record<ReplyLintCode, string> = {
  compensation: "返金・無料・割引・次回のサービスなど、補償や特典を約束している",
  liability_admission: "責任を全面的に認める表現がある(当店の過失・全面的に など)",
  causal_admission:
    "口コミの出来事を、店舗が原因だと認める書き方をしている(「〜によりご不快な思いをさせてしまい」など)。「〜について、ご不快な思いをされたとのこと」のように、お客様が感じたことへの気持ちとして書き直す",
  incident_admission:
    "口コミに書かれた出来事(待たせた・説明が不足していた・予約を変更した・スタッフの不手際 など)を、店舗がしたこととして認めている。「お待ちいただいたとのこと」「ご説明が分かりにくかったとのこと」のように、お客様の受け止めとして書き直す(受け止める一言は残す)",
  improvement_claim: "改善や再発防止を断定している(改善いたしました・二度と起こりません など)",
  rebuttal: "お客様に反論・否定・言い訳をしている",
  contact_or_promo: "URL・電話番号・メールアドレス・クーポン・キャンペーンなど、連絡先や宣伝を書いている",
  medical: "口コミに無い医療的な表現(治る・症状・治療 など)を使っている",
  invented_visit_fact: "口コミに書かれていない来店の事実(いつも・初めて・久しぶり など)を書いている",
  revisit_in_careful: "低い評価の口コミへの返信で、再来店を誘っている",
  too_long_bytes: "返信が長すぎる(Googleの上限を超えている)",
  unsupported_number: "口コミに無い数字を書いている",
  over_apology: "謝罪の表現が多すぎる",
  decoration: "絵文字や記号の飾りを使っている",
};

/** 投稿前の確認として画面に出す文言(review の指摘と、慎重モードの注意)。 */
export const REVIEW_WARNING_MESSAGES = {
  careful_mode:
    "低い評価、またはトラブルにつながる内容を含む口コミのため、慎重な内容にしています。書かれている出来事について事実を確認し、必要に応じて編集してください。",
  unsupported_number: "口コミに書かれていない数字が含まれています。内容が正しいかご確認ください。",
  over_apology: "おわびの表現が多めです。必要に応じて調整してください。",
} as const;

export type ReplyWarningCode = keyof typeof REVIEW_WARNING_MESSAGES;
