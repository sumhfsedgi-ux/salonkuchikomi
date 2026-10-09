import { describe, expect, it } from "vitest";
import { canonicalMailbox, validateLegacyStaffSet, type LegacyStaffFacts } from "../../scripts/legacyStaffSet";

// 旧側(hmail)のスタッフの集合の確認。実際の DB での確認(静的移行・停止確認・開始・監視)は
// scripts/testdb/cutover.test.ts。

const LAVI = "11111111-1111-4111-8111-111111111111";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const L3 = "aaaaaaaa-0000-4000-8000-000000000003";
const AYANA_STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_SALON = "22222222-2222-4222-8222-222222222222";
const mapping = { salonId: LAVI, mailbox: "testshopa@gmail.com", expectedStaffCount: 3 };

function facts(overrides: Partial<LegacyStaffFacts> = {}): LegacyStaffFacts {
  return {
    existingIds: new Set([L1, L2, L3, AYANA_STAFF]),
    mailboxById: new Map([
      [L1, "testshopa@gmail.com"],
      [L2, "testshopa@gmail.com"],
      [L3, "testshopa@gmail.com"],
      [AYANA_STAFF, "testshopb@gmail.com"],
    ]),
    discoveredIds: [L1, L2, L3],
    registeredElsewhere: new Map(),
    registeredHere: [],
    ...overrides,
  };
}

const kinds = (problems: ReturnType<typeof validateLegacyStaffSet>) => problems.map((p) => p.kind);

describe("canonicalMailbox", () => {
  it("大文字・前後の空白、Gmail のドットと + 以降を同じ受信箱として扱う", () => {
    expect(canonicalMailbox(" TestShopA@Gmail.com ")).toBe("testshopa@gmail.com");
    expect(canonicalMailbox("test.shop.a+yoyaku@googlemail.com")).toBe("testshopa@gmail.com");
    expect(canonicalMailbox("test.shop.b@gmail.com")).toBe("testshopb@gmail.com");
    expect(canonicalMailbox("Shop.Name@example.co.jp")).toBe("shop.name@example.co.jp");
  });
});

describe("validateLegacyStaffSet", () => {
  it("対応表の予約受信用 Gmail のスタッフ全員(3人)と一致すれば問題なし", () => {
    expect(validateLegacyStaffSet({ targetSalonId: LAVI, requestedIds: [L3, L1, L2], mapping, facts: facts() })).toEqual([]);
  });

  it("3人中1人を指定し忘れたら拒否(指定漏れ)", () => {
    const problems = validateLegacyStaffSet({ targetSalonId: LAVI, requestedIds: [L1, L2], mapping, facts: facts() });
    expect(problems).toEqual([{ kind: "missing", id: L3 }]);
  });

  it("他店舗(ayana)のスタッフの id を混ぜたら拒否", () => {
    const problems = validateLegacyStaffSet({ targetSalonId: LAVI, requestedIds: [L1, L2, L3, AYANA_STAFF], mapping, facts: facts() });
    expect(kinds(problems)).toEqual(["other_mailbox"]);
  });

  it("存在しない id・形式の違う id・重複は拒否", () => {
    const ghost = "cccccccc-0000-4000-8000-000000000009";
    const problems = validateLegacyStaffSet({ targetSalonId: LAVI, requestedIds: [L1, L2, L3, ghost, L1, "not-a-uuid"], mapping, facts: facts() });
    expect(kinds(problems).sort()).toEqual(["duplicate", "invalid_id", "not_found"]);
  });

  it("別の店舗へ登録・移行済みの id は拒否", () => {
    const problems = validateLegacyStaffSet({
      targetSalonId: LAVI,
      requestedIds: [L1, L2, L3],
      mapping,
      facts: facts({ registeredElsewhere: new Map([[L2, OTHER_SALON]]) }),
    });
    expect(problems).toEqual([{ kind: "registered_elsewhere", id: L2, salonId: OTHER_SALON }]);
  });

  it("予約受信用 Gmail の接続が無い id(どの店舗のスタッフか確かめられない)は拒否", () => {
    const mailboxById = facts().mailboxById;
    mailboxById.delete(L3);
    const problems = validateLegacyStaffSet({
      targetSalonId: LAVI,
      requestedIds: [L1, L2, L3],
      mapping,
      facts: facts({ mailboxById, discoveredIds: [L1, L2] }),
    });
    expect(kinds(problems).sort()).toEqual(["count_mismatch", "no_mail_connection"]);
  });

  it("旧側で見つかった人数が、運営が確認した人数と違えば拒否(旧側の行が増えた・減った)", () => {
    const L4 = "aaaaaaaa-0000-4000-8000-000000000004";
    const problems = validateLegacyStaffSet({
      targetSalonId: LAVI,
      requestedIds: [L1, L2, L3],
      mapping,
      facts: facts({ discoveredIds: [L1, L2, L3, L4] }),
    });
    expect(kinds(problems).sort()).toEqual(["count_mismatch", "missing"]);
  });

  it("対応表が無い・別の店舗の対応表なら、Gmail アドレスから推定せずに拒否", () => {
    expect(kinds(validateLegacyStaffSet({ targetSalonId: LAVI, requestedIds: [L1, L2, L3], mapping: null, facts: facts() }))).toEqual(["no_mapping"]);
    expect(
      kinds(validateLegacyStaffSet({ targetSalonId: OTHER_SALON, requestedIds: [L1, L2, L3], mapping, facts: facts() }))
    ).toEqual(["mapping_for_other_salon"]);
  });

  it("登録済みと違う集合での再実行は、黙って足し引きせずに拒否", () => {
    const problems = validateLegacyStaffSet({
      targetSalonId: LAVI,
      requestedIds: [L1, L2, L3],
      mapping,
      facts: facts({ registeredHere: [L1, L2] }),
    });
    expect(kinds(problems)).toEqual(["registered_set_differs"]);
    expect(validateLegacyStaffSet({ targetSalonId: LAVI, requestedIds: [L1, L2, L3], mapping, facts: facts({ registeredHere: [L1, L2, L3] }) })).toEqual([]);
  });
});
