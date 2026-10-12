import { describe, expect, it } from "vitest";
import { describeChanges, type FeatureChangeInput } from "@/lib/ops/impact";

// 管理画面の確認に出す変更内容と影響。利用許可と稼働状態を混同しない書き方になっていること。

function feature(over: Partial<FeatureChangeInput>): FeatureChangeInput {
  return {
    key: "reservation_notifications",
    label: "予約通知",
    hasRuntime: true,
    beforeOverride: "inherit",
    afterOverride: "deny",
    before: { allowed: true, reason: "plan_default" },
    after: { allowed: false, reason: "override_deny" },
    holdOpen: false,
    runtimeStarted: true,
    ...over,
  };
}

describe("予約通知", () => {
  it("稼働中に利用不可にすると、新しい送信を始めないこと・送信開始済みは続くこと・自動で再開しないことを出す", () => {
    const [s] = describeChanges({ planBefore: "salonpack", planAfter: "salonpack", features: [feature({})] });
    expect(s.revokes).toBe(true);
    expect(s.title).toBe("予約通知: プランに従う → 個別に利用不可");
    const text = s.details.join("\n");
    expect(text).toContain("新しい予約メールの確認と通知の送信を始めません");
    expect(text).toContain("送信を開始済みの通知は完了まで続きます");
    expect(text).toContain("自動では再開せず");
    expect(text).toContain("残ります");
  });

  it("開始前の店舗では、停止の記録を作らないと出す", () => {
    const [s] = describeChanges({ planBefore: "salonpack", planAfter: "salonpack", features: [feature({ runtimeStarted: false })] });
    expect(s.details.join("\n")).toContain("停止の記録は作りません");
  });

  it("再び許可しても、権限による停止が開いていれば送信は再開しないと出す", () => {
    const [s] = describeChanges({
      planBefore: "salonpack",
      planAfter: "salonpack",
      features: [feature({ beforeOverride: "deny", afterOverride: "inherit", before: { allowed: false, reason: "override_deny" }, after: { allowed: true, reason: "plan_default" }, holdOpen: true })],
    });
    expect(s.revokes).toBe(false);
    expect(s.details.join("\n")).toContain("送信は再開しません");
  });

  it("許可しただけでは連携・通知を始めないと出す(開始前)", () => {
    const [s] = describeChanges({
      planBefore: "reviews",
      planAfter: "salonpack",
      features: [feature({ beforeOverride: "inherit", afterOverride: "inherit", before: { allowed: false, reason: "not_in_plan" }, after: { allowed: true, reason: "plan_default" }, runtimeStarted: false })],
    }).slice(1);
    expect(s.title).toBe("予約通知");
    expect(s.details.join("\n")).toContain("この保存だけでは連携や通知を始めません");
  });
});

describe("口コミ・プランの変更", () => {
  it("口コミを止めると、お客様用ページ・生成も止めること、理由を出さないこと、データは消さないことを出す", () => {
    const [s] = describeChanges({
      planBefore: "reviews",
      planAfter: "reviews",
      features: [feature({ key: "reviews", label: "口コミ", hasRuntime: false, runtimeStarted: false })],
    });
    const text = s.details.join("\n");
    expect(text).toContain("お客様用ページ、口コミ文章の生成を止めます");
    expect(text).toContain("現在ご利用いただけません");
    expect(text).toContain("削除しません");
  });

  it("プランを変えると、対象外になる個別設定は残るが効かないと出す", () => {
    const summaries = describeChanges({
      planBefore: "salonpack",
      planAfter: "reviews",
      features: [
        feature({ key: "blog", label: "ブログ", hasRuntime: false, beforeOverride: "allow", afterOverride: "allow", before: { allowed: true, reason: "override_allow" }, after: { allowed: false, reason: "not_in_plan" } }),
      ],
    });
    expect(summaries[0].title).toBe("契約プラン: SalonPack → 口コミプラン");
    expect(summaries[0].details.join("\n")).toContain("ブログの個別設定(個別に許可)は残りますが、口コミプランの対象外のため効きません。");
    expect(summaries[1]).toMatchObject({ title: "ブログ", revokes: true });
  });

  it("変更が無ければ何も出さない", () => {
    expect(describeChanges({ planBefore: "salonpack", planAfter: "salonpack", features: [feature({ afterOverride: "inherit", after: { allowed: true, reason: "plan_default" } })] })).toEqual([]);
  });
});
