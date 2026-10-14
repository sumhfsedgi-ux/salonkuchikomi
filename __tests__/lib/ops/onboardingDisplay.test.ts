import { describe, expect, it } from "vitest";
import { invitationStatusText, serviceStatusChangeNotes, usableFeatureLabels, verificationText } from "@/lib/ops/onboardingDisplay";
import { missingForRegistration, parseDraftForm } from "@/lib/ops/draftForm";
import { previewServiceAccess, type PlanRules } from "@/lib/ops/preview";
import { describeAuditEntry } from "@/lib/ops/auditDisplay";
import type { AuditEntry } from "@/lib/ops/queries";

const RULES: PlanRules = { reviews: { reviews: true }, salonpack: { reviews: true, blog: true, reservation_notifications: true } };
const AVAILABLE = { lifecycle: "available" as const, hasRuntime: false };
const CATALOG = { reviews: AVAILABLE, blog: AVAILABLE, reservation_notifications: { lifecycle: "available" as const, hasRuntime: true } };

describe("本人確認(招待手続き)の表示", () => {
  it("メールの確認と本人確認の記録の両方で「完了」。送信の受付だけでは完了にしない", () => {
    expect(verificationText({ ownerEmailConfirmed: false, ownerVerified: false, ownerVerificationMethod: null })).toEqual({
      complete: false,
      label: "招待未完了(メールアドレスの確認がまだ)",
    });
    expect(verificationText({ ownerEmailConfirmed: true, ownerVerified: false, ownerVerificationMethod: null }).label).toBe("招待未完了(パスワードの設定がまだ)");
    expect(verificationText({ ownerEmailConfirmed: true, ownerVerified: true, ownerVerificationMethod: "password_set" })).toEqual({
      complete: true,
      label: "招待手続き完了(本人がパスワードを設定)",
    });
    expect(verificationText({ ownerEmailConfirmed: true, ownerVerified: true, ownerVerificationMethod: "legacy" }).label).toMatch(/既存のアカウント/);
  });
});

describe("案内のメールの送信の表示", () => {
  const base = { lastKind: "invite" as const, lastAttemptAt: null, lastError: null, lastAcceptedAt: null, firstAcceptedAt: null, attempts24h: 1, nextSendAt: null };
  const now = new Date("2026-10-14T00:10:00Z");
  it("受付・失敗・検証モード・結果不明を分け、「届いた」とは書かない", () => {
    const accepted = invitationStatusText({ ...base, lastResult: "accepted" }, now);
    expect(accepted.lastResultText).toMatch(/送信を受け付けました/);
    expect(accepted.lastResultText).not.toMatch(/届きました|読まれました|利用開始済み/);
    const failed = invitationStatusText({ ...base, lastResult: "failed", lastError: "rate_limited" }, now);
    expect(failed.failure).toMatch(/時間をおいて/);
    expect(invitationStatusText({ ...base, lastResult: "simulated" }, now).lastResultText).toMatch(/検証モード/);
    const stale = invitationStatusText({ ...base, lastResult: "sending", lastAttemptAt: "2026-10-14T00:00:00Z" }, now);
    expect(stale.lastResultText).toMatch(/確認できませんでした/);
  });
  it("60秒あける・24時間で10回まで", () => {
    expect(invitationStatusText({ ...base, lastResult: "accepted", nextSendAt: "2026-10-14T00:10:30Z" }, now)).toMatchObject({ canResend: false, waitSeconds: 30 });
    expect(invitationStatusText({ ...base, lastResult: "accepted", attempts24h: 10 }, now).canResend).toBe(false);
    expect(invitationStatusText({ ...base, lastResult: "accepted" }, now).canResend).toBe(true);
  });
});

describe("利用区分の変更・本登録の確認", () => {
  it("利用開始待ちでは、本来なら使える機能だけ使えない(対象外・準備中・個別に不可の理由は変えない)", () => {
    expect(previewServiceAccess(AVAILABLE, RULES, "reviews", "reviews", "inherit", "pending")).toEqual({ allowed: false, reason: "service_pending" });
    expect(previewServiceAccess(AVAILABLE, RULES, "reviews", "blog", "inherit", "pending")).toEqual({ allowed: false, reason: "not_in_plan" });
    expect(previewServiceAccess(AVAILABLE, RULES, "salonpack", "blog", "deny", "pending")).toEqual({ allowed: false, reason: "override_deny" });
    expect(previewServiceAccess(AVAILABLE, RULES, "salonpack", "blog", "inherit", "test")).toEqual({ allowed: true, reason: "plan_default" });
  });
  it("変更のあとに使える機能と、変わらないこと(停止・予約通知の開始)を出す", () => {
    const after = usableFeatureLabels(CATALOG, RULES, "salonpack", { blog: "deny" }, "complimentary");
    expect(after).toEqual(["口コミ", "予約通知"]);
    expect(usableFeatureLabels(CATALOG, RULES, "salonpack", {}, "pending")).toEqual([]);
    const notes = serviceStatusChangeNotes({ from: "complimentary", to: "pending", before: ["口コミ"], after: [], reservationActive: true });
    expect(notes.join("\n")).toMatch(/【使えなくなります】口コミ/);
    expect(notes.join("\n")).toMatch(/自動で開始・再開しません/);
    expect(notes.join("\n")).toMatch(/権限による停止/);
    expect(serviceStatusChangeNotes({ from: "pending", to: "test", before: [], after: ["口コミ"], reservationActive: false }).join("\n")).toMatch(/機能や権限は広がりません/);
  });
});

describe("サロンを追加の入力", () => {
  it("下書きはサロン名だけで保存できる。本登録には担当者名・ログイン用メール・プラン・利用区分が要る", () => {
    const r = parseDraftForm({ name: "名前だけ" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields).toMatchObject({ name: "名前だけ", contact_name: null, login_email: null, plan: null, service_status: null, contact_email: null });
      expect(Object.keys(missingForRegistration(r.fields)).sort()).toEqual(["contactName", "loginEmail", "plan", "serviceStatus"]);
    }
  });
  it("形式の誤りは項目ごと。連絡用メールがログイン用と同じなら保存しない", () => {
    const bad = parseDraftForm({ name: "x", loginEmail: "nope", contactEmailMode: "other", contactEmail: "", plan: "gold" });
    expect(bad.ok).toBe(false);
    const same = parseDraftForm({ name: "x", loginEmail: "A@example.test", contactEmailMode: "other", contactEmail: "a@example.test" });
    expect(same.ok && same.fields.contact_email).toBe(null);
    const overrides = parseDraftForm({ name: "x", featureOverrides: { blog: "deny" } });
    expect(overrides.ok && overrides.fields.feature_overrides).toEqual({ blog: "deny" });
  });
});

describe("変更履歴の新しい種類", () => {
  const base: AuditEntry = { id: "1", occurredAt: "2026-10-14T00:00:00Z", actorKind: "operator", actorEmail: "ops@example.test", actorLabel: null, target: "", before: null, after: null, note: null };
  const ctx = { rules: RULES, plan: "reviews" as const };
  it("利用区分・登録・案内の送信を、言葉で出す(機械向けの値は出さない)", () => {
    expect(describeAuditEntry({ ...base, target: "service_status", before: "pending", after: "complimentary" }, ctx).change).toBe("利用区分: 利用開始待ち → 無償提供");
    expect(describeAuditEntry({ ...base, target: "registration", after: { source: "operator", plan: "salonpack", service_status: "test" } }, ctx).change).toBe(
      "運営が店舗を本登録(SalonPack・テスト店舗)",
    );
    const own = describeAuditEntry({ ...base, actorKind: "owner", actorEmail: null, target: "registration", after: { source: "self_signup", plan: "reviews", service_status: "pending" } }, ctx);
    expect(own).toMatchObject({ actor: "変更者: お客様(店舗のオーナー)", change: "お客様が店舗を登録(口コミプラン・利用開始待ち)" });
    expect(describeAuditEntry({ ...base, target: "invitation", after: { kind: "invite", result: "accepted" } }, ctx).change).toBe("招待のメール: 送信を受け付けました");
    expect(describeAuditEntry({ ...base, target: "invitation", after: { kind: "salon_notice", result: "failed", error: "rate_limited" } }, ctx).change).toMatch(
      /^店舗登録のお知らせ: 送信できませんでした/,
    );
    const migration = describeAuditEntry(
      { ...base, actorKind: "sql", actorEmail: null, actorLabel: "migration:0025", target: "service_status", after: "complimentary", note: "0025 の適用時点で存在した店舗を、無償提供として移行" },
      ctx,
    );
    expect(migration).toMatchObject({ actor: "変更者: 移行(0025)", change: "利用区分を無償提供に設定" });
  });
});
