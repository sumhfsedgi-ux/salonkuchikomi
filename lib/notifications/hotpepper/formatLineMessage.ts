// (hmailの lib/hotpepper/formatLineMessage.ts を無変更で移植)
import type { ParsedReservation } from "./types";

function nameLine(customerName?: string): string | undefined {
  return customerName ? `${customerName}様` : undefined;
}

function newReservationText(parsed: ParsedReservation): string {
  const sections = [
    "【新しい予約】",
    parsed.current.dateTimeText,
    nameLine(parsed.current.customerName),
    parsed.current.menu,
    "Hot Pepperに新しい予約が入りました。",
  ].filter((section): section is string => Boolean(section));
  return sections.join("\n\n");
}

function cancellationText(parsed: ParsedReservation): string {
  const infoLines = [
    parsed.current.dateTimeText,
    nameLine(parsed.current.customerName),
  ].filter((line): line is string => Boolean(line));

  const sections = [
    "【予約キャンセル】",
    infoLines.length > 0 ? infoLines.join("\n") : undefined,
    "予約がキャンセルされました。",
  ].filter((section): section is string => Boolean(section));
  return sections.join("\n\n");
}

function genericReservationText(parsed: ParsedReservation): string {
  const sections = [
    "【予約に関する通知】",
    parsed.current.dateTimeText,
    nameLine(parsed.current.customerName),
    parsed.current.menu,
    "Hot Pepperに予約に関する通知が届きました。",
  ].filter((section): section is string => Boolean(section));
  return sections.join("\n\n");
}

/**
 * 抽出済みの予約データから、短くモバイル向けのLINEテキストを組み立てる。
 * 生のメール本文は絶対に含めず、実際に抽出できた項目だけを出す。
 */
export function formatLineMessage(parsed: ParsedReservation): string {
  switch (parsed.eventType) {
    case "new_reservation":
      return newReservationText(parsed);
    case "cancellation":
      return cancellationText(parsed);
    default:
      return genericReservationText(parsed);
  }
}
