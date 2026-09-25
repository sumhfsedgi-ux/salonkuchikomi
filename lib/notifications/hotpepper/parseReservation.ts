// (hmailの lib/hotpepper/parseReservation.ts を無変更で移植)
import type { EventType, ParsedReservation, ReservationDetails } from "./types";

// SALON BOARDの実際のメールは日時を「2026年08月14日（金）19:30」のように書く
// (全角括弧、年は省略されることもある)。未確認のテンプレート差異にも
// 耐えるよう、半角括弧・年省略・範囲表記の「〜」も許容する。
const DATE_TIME_PATTERN =
  /(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:[（(][月火水木金土日][）)])?\s*\d{1,2}:\d{2}(?:\s*[〜~\-−](?:\s*\d{1,2}:\d{2})?)?/;

const DATE_TIME_LABELS = "来店日時|予約日時|ご予約日時";
const NAME_LABELS = "氏名|お客様名|ご予約者様?名?|お名前";
const MENU_LABELS = "メニュー|コース|ご利用メニュー";

/**
 * SALON BOARDの実際のテンプレート(実サンプルで確認済み)は「■来店日時」の
 * ようにラベル単独の行があり、値は次の行に来る
 * (例: "■来店日時\n　2026年08月14日（金）19:30")。まずこれを試し、
 * 見つからなければ同一行の「ラベル：値」パターンにフォールバックする。
 */
function extractAfterBoxLabel(text: string, labelAlternation: string): string | undefined {
  const pattern = new RegExp(`■(?:${labelAlternation})[ \t]*\r?\n[ \t　]*([^\r\n]+)`);
  const match = text.match(pattern);
  return match ? match[1].trim() : undefined;
}

/** 末尾のふりがな注記を取り除く。例: "山田花子（ヤマダハナコ）" → "山田花子"。 */
function stripFurigana(name: string): string {
  return name.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
}

function extractDateTime(text: string): string | undefined {
  const boxed = extractAfterBoxLabel(text, DATE_TIME_LABELS);
  if (boxed) {
    const match = boxed.match(DATE_TIME_PATTERN);
    if (match) return match[0].trim();
  }

  const sameLine = text.match(
    new RegExp(`(?:${DATE_TIME_LABELS})[：:]\\s*(${DATE_TIME_PATTERN.source})`)
  );
  if (sameLine) return sameLine[1].trim();

  const bare = text.match(DATE_TIME_PATTERN);
  return bare ? bare[0].trim() : undefined;
}

function extractCustomerName(text: string): string | undefined {
  const boxed = extractAfterBoxLabel(text, NAME_LABELS);
  if (boxed) return stripFurigana(boxed.replace(/様\s*$/, ""));

  const sameLine = text.match(
    new RegExp(`(?:${NAME_LABELS})[：:]\\s*([^\\n　]+?)\\s*様?\\s*$`, "m")
  );
  if (sameLine) return stripFurigana(sameLine[1]);

  const bareLine = text.match(/^\s*([^\s　]{1,20})様\s*$/m);
  if (bareLine && bareLine[1] !== "お客" && bareLine[1] !== "客") return bareLine[1].trim();

  return undefined;
}

function extractMenu(text: string): string | undefined {
  const boxed = extractAfterBoxLabel(text, MENU_LABELS);
  if (boxed) return boxed;

  const sameLine = text.match(new RegExp(`(?:${MENU_LABELS})[：:]\\s*([^\\n]+)`));
  return sameLine ? sameLine[1].trim() : undefined;
}

function extractCommonFields(body: string): ReservationDetails {
  const details: ReservationDetails = {};
  const dateTimeText = extractDateTime(body);
  const customerName = extractCustomerName(body);
  const menu = extractMenu(body);
  if (dateTimeText) details.dateTimeText = dateTimeText;
  if (customerName) details.customerName = customerName;
  if (menu) details.menu = menu;
  return details;
}

/**
 * メール本文に実際に存在する予約項目だけを抽出する。無い項目は単に
 * undefinedのまま(推測・補完はしない)。
 */
export function parseReservation(
  bodyText: string,
  eventType: EventType
): ParsedReservation {
  return {
    eventType,
    current: extractCommonFields(bodyText),
  };
}
