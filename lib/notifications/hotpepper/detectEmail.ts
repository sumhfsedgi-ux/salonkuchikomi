// (hmailの lib/hotpepper/detectEmail.ts を無変更で移植)
import type { DetectionResult, EventType, RawEmail } from "./types";
import {
  SENDER_DOMAIN_PATTERNS,
  NEW_RESERVATION_SUBJECT_PATTERNS,
  CANCELLATION_SUBJECT_PATTERNS,
  GENERIC_RESERVATION_SUBJECT_PATTERNS,
} from "./senderPatterns";

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isFromHotPepper(email: RawEmail): boolean {
  return matchesAny(SENDER_DOMAIN_PATTERNS, email.from);
}

function classifyEventType(email: RawEmail): EventType {
  if (matchesAny(CANCELLATION_SUBJECT_PATTERNS, email.subject)) return "cancellation";
  if (matchesAny(NEW_RESERVATION_SUBJECT_PATTERNS, email.subject)) return "new_reservation";
  if (matchesAny(GENERIC_RESERVATION_SUBJECT_PATTERNS, email.subject)) return "unknown";
  return "unknown";
}

/**
 * メールがHot Pepper Beautyの予約関連メールかどうか、該当する場合は
 * どのイベント種別かを判定する。分類できない場合も例外を投げず
 * isHotPepper: true, eventType: 'unknown' として扱う(通知自体は送る)。
 */
export function detectEmail(email: RawEmail): DetectionResult {
  if (!isFromHotPepper(email)) {
    return { isHotPepper: false, eventType: "not_hotpepper" };
  }
  return { isHotPepper: true, eventType: classifyEventType(email) };
}
