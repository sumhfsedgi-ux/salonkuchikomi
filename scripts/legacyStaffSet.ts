// 旧サービス(hmail)のスタッフ行の集合が、移行先の店舗に対して正しいかの判定(DB に触れない純粋な関数)。
// scripts/notifications-ops/core.ts の静的移行・停止で、書き込みの前に使う。DB 側の最後の防御は
// reservation_ops_mark_legacy / reservation_ops_legacy_check(0022)。
//
// 旧側のスタッフ行は、ログイン用のメールアドレスではなく、予約メールを受け取っている Gmail
// (hmail.mail_connections.email_address)で見つける。新側の店舗との対応は、Gmail アドレスから推定せず、
// 運営が確認した対応表(legacy_salon_mappings)を使う。

/** 0022 の public.legacy_mailbox_canonical と同じ規則。 */
export function canonicalMailbox(address: string): string {
  const addr = address.trim().toLowerCase();
  const at = addr.indexOf("@");
  if (at <= 0 || at === addr.length - 1) return addr;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1).split("@")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.split("+")[0].replaceAll(".", "")}@gmail.com`;
  }
  return addr;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LegacyMapping {
  salonId: string;
  mailbox: string;
  expectedStaffCount: number;
}

export interface LegacyStaffFacts {
  /** 指定された id のうち、旧側にスタッフ(hmail.salons)として存在するもの。 */
  existingIds: Set<string>;
  /** 指定された id の、予約受信用 Gmail(比較用の形)。受信用 Gmail の接続が無い id は含まれない。 */
  mailboxById: Map<string, string>;
  /** 対応表の予約受信用 Gmail で見つかった旧側のスタッフ行の id。 */
  discoveredIds: string[];
  /** 他の新側の店舗に登録済みの id → その店舗。 */
  registeredElsewhere: Map<string, string>;
  /** この店舗に登録済みの id(再実行のとき)。 */
  registeredHere: string[];
}

export type StaffSetProblem =
  | { kind: "no_mapping" }
  | { kind: "mapping_for_other_salon"; salonId: string }
  | { kind: "empty" }
  | { kind: "invalid_id"; id: string }
  | { kind: "duplicate"; id: string }
  | { kind: "not_found"; id: string }
  | { kind: "no_mail_connection"; id: string }
  | { kind: "other_mailbox"; id: string }
  | { kind: "missing"; id: string }
  | { kind: "registered_elsewhere"; id: string; salonId: string }
  | { kind: "count_mismatch"; expected: number; discovered: number }
  | { kind: "registered_set_differs"; registered: string[] };

/**
 * 指定されたスタッフの id の集合が、対応表の予約受信用 Gmail で見つかる旧側のスタッフ行と完全に一致するか。
 * 問題が1つでもあれば書き込まない(指定漏れ・他店舗の id・存在しない id・別店舗へ移行済みの id・人数の不一致)。
 */
export function validateLegacyStaffSet(input: {
  targetSalonId: string;
  requestedIds: string[];
  mapping: LegacyMapping | null;
  facts: LegacyStaffFacts;
}): StaffSetProblem[] {
  const problems: StaffSetProblem[] = [];
  const { mapping, facts } = input;
  if (!mapping) return [{ kind: "no_mapping" }];
  if (mapping.salonId !== input.targetSalonId) return [{ kind: "mapping_for_other_salon", salonId: mapping.salonId }];
  if (input.requestedIds.length === 0) problems.push({ kind: "empty" });

  const seen = new Set<string>();
  for (const id of input.requestedIds) {
    if (!UUID.test(id)) {
      problems.push({ kind: "invalid_id", id });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ kind: "duplicate", id });
      continue;
    }
    seen.add(id);
    if (!facts.existingIds.has(id)) {
      problems.push({ kind: "not_found", id });
      continue;
    }
    const mailbox = facts.mailboxById.get(id);
    if (!mailbox) problems.push({ kind: "no_mail_connection", id });
    else if (mailbox !== mapping.mailbox) problems.push({ kind: "other_mailbox", id });
    const elsewhere = facts.registeredElsewhere.get(id);
    if (elsewhere) problems.push({ kind: "registered_elsewhere", id, salonId: elsewhere });
  }
  for (const id of facts.discoveredIds) {
    if (!seen.has(id)) problems.push({ kind: "missing", id });
  }
  if (facts.discoveredIds.length !== mapping.expectedStaffCount) {
    problems.push({ kind: "count_mismatch", expected: mapping.expectedStaffCount, discovered: facts.discoveredIds.length });
  }
  const registered = [...facts.registeredHere].sort();
  const requested = [...seen].sort();
  if (registered.length > 0 && registered.join(",") !== requested.join(",")) {
    problems.push({ kind: "registered_set_differs", registered });
  }
  return problems;
}

export function describeStaffSetProblem(p: StaffSetProblem): string {
  switch (p.kind) {
    case "no_mapping":
      return "対応表(legacy_salon_mappings)にこの店舗がありません。先に map で、運営が確認した予約受信用 Gmail とスタッフの人数を登録してください。";
    case "mapping_for_other_salon":
      return `対応表の店舗(${p.salonId})と移行先が違います。`;
    case "empty":
      return "スタッフの id が指定されていません。";
    case "invalid_id":
      return `id の形式が正しくありません: ${p.id}`;
    case "duplicate":
      return `同じ id が重複しています: ${p.id}`;
    case "not_found":
      return `旧側に存在しない id です: ${p.id}`;
    case "no_mail_connection":
      return `予約受信用 Gmail の接続が無く、どの店舗のスタッフか確かめられない id です: ${p.id}`;
    case "other_mailbox":
      return `別の予約受信用 Gmail(他の店舗)のスタッフの id です: ${p.id}`;
    case "missing":
      return `指定漏れ: 対応表の予約受信用 Gmail のスタッフ ${p.id} が指定されていません。`;
    case "registered_elsewhere":
      return `別の店舗(${p.salonId})へ登録・移行済みの id です: ${p.id}`;
    case "count_mismatch":
      return `対応表のスタッフの人数(${p.expected}人)と、予約受信用 Gmail で見つかった旧側のスタッフ(${p.discovered}人)が一致しません。`;
    case "registered_set_differs":
      return `この店舗に登録済みのスタッフ(${p.registered.join(", ")})と違う集合です。黙って足し引きしません。`;
  }
}
