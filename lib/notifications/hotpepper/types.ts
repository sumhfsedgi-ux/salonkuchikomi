// (hmailの lib/hotpepper/types.ts を無変更で移植)

export type EventType =
  | "new_reservation"
  | "cancellation"
  | "unknown"
  | "not_hotpepper";

export interface RawEmail {
  from: string;
  subject: string;
  bodyText: string;
}

export interface DetectionResult {
  isHotPepper: boolean;
  eventType: EventType;
}

/**
 * 1通のメールから抽出した予約情報のスナップショット。実際にメール本文に
 * 存在した項目だけを持つ(推測・補完は一切しない)。
 */
export interface ReservationDetails {
  dateTimeText?: string;
  customerName?: string;
  menu?: string;
}

export interface ParsedReservation {
  eventType: EventType;
  current: ReservationDetails;
}
