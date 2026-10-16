import { describe, expect, it } from "vitest";
import { describeAuditEntry, NO_ACTOR_RECORD } from "@/lib/ops/auditDisplay";
import type { PlanRules } from "@/lib/ops/preview";
import type { AuditEntry } from "@/lib/ops/queries";

// 変更履歴の表示: 変更日時・変更者・変更内容・メモだけを出し、変更の方法(SQL・CLI)・DBのロール名・内部ID・JSONを出さない。
// 変更者は記録にあるものだけを出し、推測しない。DB の記録は書き換えない(表示だけ)。

const RULES: PlanRules = { reviews: { reviews: true }, salonpack: { reviews: true, blog: true, reservation_notifications: true } };
const ctx = { rules: RULES, plan: "salonpack" as const };

function entry(over: Partial<AuditEntry>): AuditEntry {
  return {
    id: "1",
    occurredAt: "2026-10-12T13:48:00Z",
    actorKind: "operator",
    actorEmail: "ops@example.test",
    actorLabel: null,
    target: "feature:blog",
    before: "inherit",
    after: "deny",
    note: null,
    ...over,
  };
}

const INTERNAL = /SQL|CLI|postgres|salon_plan_changes|operator:|\{|\}|inherit|deny|allow/;

describe("変更内容", () => {
  it("機能の利用許可は、スイッチと同じ言葉で出す", () => {
    expect(describeAuditEntry(entry({}), ctx)).toEqual({ actor: "変更者: ops@example.test", change: "ブログ: 利用を許可 → 利用を許可しない", memo: null });
  });

  it("プランの対象外のときの記録も、その機能を含むプランの初期設定で読む", () => {
    const v = describeAuditEntry(entry({ before: "deny", after: "inherit" }), { rules: RULES, plan: "reviews" });
    expect(v.change).toBe("ブログ: 利用を許可しない → 利用を許可");
  });

  it("契約プラン・権限による停止・解除", () => {
    expect(describeAuditEntry(entry({ target: "plan", before: "reviews", after: "salonpack" }), ctx).change).toBe("契約プラン: 口コミプラン → SalonPack");
    expect(describeAuditEntry(entry({ target: "hold:reservation_notifications", before: "none", after: "open", actorKind: "system" }), ctx).change).toBe(
      "予約通知を権限により停止(利用許可・利用区分の変更で使えなくなったため)",
    );
    expect(describeAuditEntry(entry({ target: "hold:reservation_notifications", before: { opened_at: "2026-10-12T13:00:00Z" }, after: "released" }), ctx).change).toBe(
      "予約通知の権限による停止を解除",
    );
  });

  it("知らない記録でも、JSON や内部の識別子を出さない", () => {
    const v = describeAuditEntry(entry({ target: "something:x", before: { a: 1 }, after: { b: 2 } }), ctx);
    expect(v.change).toBe("設定の変更");
    expect(`${v.actor}${v.change}${v.memo ?? ""}`).not.toMatch(INTERNAL);
  });
});

describe("変更者とメモ", () => {
  it("移行で写した契約変更: 変更の方法・ロール名・テーブル名を出さず、運用CLIが記録した作業者とメモ本文を出す", () => {
    const v = describeAuditEntry(
      entry({
        actorKind: "sql",
        actorEmail: null,
        actorLabel: "postgres",
        target: "plan",
        before: "reviews",
        after: "salonpack",
        note: "operator:sumhfsedgi ayana 予約通知の切り替えのため [salon_plan_changes #2]",
      }),
      ctx,
    );
    expect(v).toEqual({ actor: "変更者: sumhfsedgi", change: "契約プラン: 口コミプラン → SalonPack", memo: "ayana 予約通知の切り替えのため" });
    expect(`${v.actor}${v.change}${v.memo}`).not.toMatch(INTERNAL);
  });

  it("SQLでの変更で作業者の記録が無ければ、推測せず「変更者の記録なし」", () => {
    const v = describeAuditEntry(entry({ actorKind: "sql", actorEmail: null, actorLabel: "postgres", note: "契約の確認のため" }), ctx);
    expect(v.actor).toBe(NO_ACTOR_RECORD);
    expect(v.memo).toBe("契約の確認のため");
  });

  it("運用CLIの変更は、記録された作業者を出す(方法は出さない)", () => {
    const v = describeAuditEntry(entry({ actorKind: "cli", actorEmail: null, actorLabel: "operator:yamada", note: "operator:yamada 契約更新" }), ctx);
    expect(v).toMatchObject({ actor: "変更者: yamada", memo: "契約更新" });
  });

  it("管理画面の変更で、管理者のメールアドレスが読めなければ「変更者の記録なし」", () => {
    expect(describeAuditEntry(entry({ actorEmail: null }), ctx).actor).toBe(NO_ACTOR_RECORD);
  });

  it("自動の記録は「システムによる変更」とし、きっかけの変更者が記録にあれば添える。システムが書いた説明はメモとして出さない", () => {
    const withEmail = describeAuditEntry(entry({ actorKind: "system", actorLabel: "operator:00000000-0000-4000-8000-0000000000a1", note: "利用不可になったため自動で停止" }), ctx);
    expect(withEmail).toMatchObject({ actor: "システムによる変更(ops@example.test の変更に伴う)", memo: null });
    const noRecord = describeAuditEntry(entry({ actorKind: "system", actorEmail: null, actorLabel: "operator:00000000-0000-4000-8000-0000000000a1" }), ctx);
    expect(noRecord.actor).toBe("システムによる変更");
    const bySql = describeAuditEntry(entry({ actorKind: "system", actorEmail: null, actorLabel: "sql:postgres" }), ctx);
    expect(bySql.actor).toBe("システムによる変更");
  });

  it("人が入力したメモの文は削らない(内部の目印だけを外す)", () => {
    const note = "SQLの手順書(operator向け)を確認して変更";
    expect(describeAuditEntry(entry({ note }), ctx).memo).toBe(note);
  });
});
