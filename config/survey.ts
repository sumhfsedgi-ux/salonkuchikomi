export type QuestionType = "multi-select" | "textarea";

interface BaseQuestion {
  id: string;
  question: string;
  required: boolean;
  type: QuestionType;
}

export interface MultiSelectQuestion extends BaseQuestion {
  type: "multi-select";
  options: string[];
  maxSelections: number;
}

export interface TextareaQuestion extends BaseQuestion {
  type: "textarea";
  placeholder?: string;
  maxLength: number;
}

export type SurveyQuestion = MultiSelectQuestion | TextareaQuestion;

// Keys here must match the `id` values in surveyQuestions below.
export interface SurveyAnswers {
  concerns: string[];
  skinImpressions: string[];
  treatmentImpressions: string[];
  salonImpressions: string[];
  freeText: string;
}

export const emptySurveyAnswers: SurveyAnswers = {
  concerns: [],
  skinImpressions: [],
  treatmentImpressions: [],
  salonImpressions: [],
  freeText: "",
};

export const surveyQuestions: SurveyQuestion[] = [
  {
    id: "concerns",
    question: "今回、どのようなお悩みでご来店されましたか？",
    required: true,
    type: "multi-select",
    maxSelections: 3,
    options: [
      "ニキビ",
      "ニキビ跡",
      "毛穴の開き",
      "毛穴の黒ずみ",
      "肌のざらつき",
      "くすみ",
      "乾燥",
      "赤み",
      "肌荒れ",
      "シミ・色ムラ",
      "ハリ不足",
      "肌質を改善したい",
      "その他",
    ],
  },
  {
    id: "skinImpressions",
    question: "施術後のお肌について、どのように感じましたか？",
    required: true,
    type: "multi-select",
    maxSelections: 3,
    options: [
      "肌がつるっとした",
      "肌がなめらかになったように感じた",
      "肌が柔らかく感じた",
      "肌が明るく見えた",
      "毛穴が目立ちにくく感じた",
      "肌のざらつきが気になりにくくなった",
      "化粧ノリが良くなったように感じた",
      "肌がしっとりした",
      "肌がスッキリした",
      "今後の変化も楽しみ",
      "その他",
    ],
  },
  {
    id: "treatmentImpressions",
    question: "施術について感じたことを教えてください",
    required: true,
    type: "multi-select",
    maxSelections: 3,
    options: [
      "施術が丁寧だった",
      "説明が分かりやすかった",
      "自分の肌に合った提案をしてくれた",
      "不安なく施術を受けられた",
      "リラックスできた",
      "思っていたより受けやすかった",
      "肌について相談しやすかった",
      "ホームケアの説明が分かりやすかった",
    ],
  },
  {
    id: "salonImpressions",
    question: "スタッフ・サロンについて感じたことを教えてください",
    required: true,
    type: "multi-select",
    maxSelections: 3,
    options: [
      "スタッフが話しやすい",
      "スタッフの対応が丁寧",
      "親身に相談に乗ってくれた",
      "清潔感がある",
      "落ち着いた雰囲気",
      "リラックスできる空間",
      "プライベート感がある",
      "初めてでも入りやすかった",
    ],
  },
  {
    id: "freeText",
    question: "その他、感じたことがあれば自由にご記入ください",
    required: false,
    type: "textarea",
    maxLength: 300,
    placeholder:
      "例：初めてのハーブピーリングでしたが、説明が丁寧で安心して受けられました。",
  },
];
