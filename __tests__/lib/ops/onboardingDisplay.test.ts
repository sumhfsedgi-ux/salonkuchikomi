import { describe, expect, it } from "vitest";
import { invitationStatusText, planDisplay, serviceStatusChangeNotes, usableFeatureLabels, verificationText } from "@/lib/ops/onboardingDisplay";
import { EMPTY_DRAFT, missingForRegistration, parseDraftForm } from "@/lib/ops/draftForm";
import {
  REGISTRATION_KIND_DESCRIPTIONS,
  REGISTRATION_KIND_LABELS,
  SERVICE_STATUS_CHANGE_OPTIONS,
  SERVICE_STATUS_LABELS,
  serviceStatusChoices,
  TEST_NEEDS_PLAN_REASON,
} from "@/lib/onboarding/serviceStatus";
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
    expect(notes.join("\n")).toMatch(/自動では開始・再開しません/);
    expect(notes.join("\n")).toMatch(/権限による停止/);
    // 利用開始待ちに戻すときは、機能が止まることをぼかさない
    expect(notes[0]).toBe("利用区分: 無料提供 → 利用停止中");
    expect(notes[1]).toMatch(/^【利用停止中にすると】この店舗では、サービスの機能が使えなくなります/);
    const toTest = serviceStatusChangeNotes({ from: "pending", to: "test", before: [], after: ["口コミ"], reservationActive: false }).join("\n");
    expect(toTest).toMatch(/テスト用でも、操作によっては実際のメール・LINE の送信が発生することがあります/);
    expect(toTest).not.toMatch(/使えなくなります/);
  });
});

describe("登録種別と利用区分の言葉(場面で分ける。値は同じ)", () => {
  it("新しい店舗の登録は「通常登録/テスト用」だけ(無料提供は選べない)。今の状態は「利用開始待ち/無料提供/テスト用」", () => {
    expect(REGISTRATION_KIND_LABELS).toEqual({ pending: "通常登録", test: "テスト用" });
    expect(SERVICE_STATUS_LABELS).toEqual({ pending: "お申し込み手続き中", complimentary: "無料提供", test: "テスト用" });
    expect(REGISTRATION_KIND_DESCRIPTIONS).toEqual({
      pending: "これから通常の契約で利用するお客様の登録です。登録しただけでは、サービスの機能は使えません(プラン選択・お支払いの手続きは準備中です)。",
      test: "運営の動作確認に使用する店舗です。料金は発生しません。",
    });
  });
  it("既存の店舗の区分の変更では、利用開始待ちへの変更を「通常登録」と書かず、機能が止まることを伝える", () => {
    expect(SERVICE_STATUS_CHANGE_OPTIONS.pending.label).toBe("利用停止中に変更");
    expect(SERVICE_STATUS_CHANGE_OPTIONS.pending.description).toMatch(/使えなくなります/);
    expect(Object.values(SERVICE_STATUS_CHANGE_OPTIONS).map((o) => o.label).join()).not.toMatch(/通常登録/);
  });
  it("運営の承認・利用開始のご案内・支払い後の利用開始を約束しない(準備中であることだけを伝える)", () => {
    const all = [...Object.values(REGISTRATION_KIND_DESCRIPTIONS), ...Object.values(SERVICE_STATUS_CHANGE_OPTIONS).map((o) => o.description)].join();
    expect(all).not.toMatch(/承認|ご案内をお送り|運営が利用開始|支払い後|お支払いのあと|支払うと/);
    expect(SERVICE_STATUS_CHANGE_OPTIONS.test.description).toMatch(/お客様の利用開始の代わりには使いません/);
  });

  it("選べる変更: 無料提供は既存の店舗だけ。プランが仮の値ならテスト用は理由を出して押せない", () => {
    const pick = (c: ReturnType<typeof serviceStatusChoices>) => c.map((x) => `${x.status}:${x.available}`);
    expect(pick(serviceStatusChoices({ status: "pending", registrationSource: "operator", planPlaceholder: false }))).toEqual(["test:true"]);
    const selfSignup = serviceStatusChoices({ status: "pending", registrationSource: "self_signup", planPlaceholder: true });
    expect(selfSignup).toEqual([{ status: "test", available: false, reason: TEST_NEEDS_PLAN_REASON }]);
    expect(pick(serviceStatusChoices({ status: "pending", registrationSource: "existing", planPlaceholder: false }))).toEqual([
      "complimentary:true",
      "test:true",
    ]);
    expect(pick(serviceStatusChoices({ status: "complimentary", registrationSource: "existing", planPlaceholder: false }))).toEqual([
      "pending:true",
      "test:true",
    ]);
    expect(pick(serviceStatusChoices({ status: "test", registrationSource: "operator", planPlaceholder: false }))).toEqual(["pending:true"]);
    expect(pick(serviceStatusChoices({ status: "test", registrationSource: "existing", planPlaceholder: false }))).toEqual([
      "pending:true",
      "complimentary:true",
    ]);
  });

  it("プランの表示: 予定のプランを現在の契約と書かない。仮の値は未定", () => {
    expect(planDisplay({ plan: "salonpack", planPlaceholder: false, serviceStatus: "test", registrationSource: "operator" })).toMatchObject({
      kind: "contract",
      label: "契約プラン",
      text: "SalonPack",
    });
    expect(planDisplay({ plan: "salonpack", planPlaceholder: false, serviceStatus: "pending", registrationSource: "operator" })).toMatchObject({
      kind: "planned",
      label: "案内予定のプラン",
      text: "SalonPack(契約ではありません)",
    });
    expect(planDisplay({ plan: "reviews", planPlaceholder: true, serviceStatus: "pending", registrationSource: "self_signup" })).toEqual({
      kind: "unset",
      plan: null,
      label: "プラン",
      text: "未定",
    });
    expect(planDisplay({ plan: "reviews", planPlaceholder: false, serviceStatus: "pending", registrationSource: "existing" })).toMatchObject({
      kind: "contract_stopped",
      text: "口コミプラン(利用停止中)",
    });
  });

  it("利用開始待ちから利用中にするときは、そのときから契約プランとして使うプランを出す", () => {
    const notes = serviceStatusChangeNotes({ from: "pending", to: "test", before: [], after: ["口コミ"], reservationActive: false, startPlan: "salonpack" });
    expect(notes[1]).toBe("【契約プラン】SalonPackを、このときから契約プランとして使います(お申し込み手続き中の間は、契約ではありませんでした)。");
    const stop = serviceStatusChangeNotes({ from: "test", to: "pending", before: ["口コミ"], after: [], reservationActive: false, startPlan: "salonpack" });
    expect(stop.join("\n")).not.toMatch(/【契約プラン】/);
  });
  it("新しい下書きは「通常登録」(pending)を初期選択にする", () => {
    expect(EMPTY_DRAFT.serviceStatus).toBe("pending");
  });
});

describe("サロンを追加の入力", () => {
  it("下書きはサロン名だけで保存できる。本登録には担当者名・ログイン用メール・登録種別が要る(プランはテスト用だけ必須)", () => {
    const r = parseDraftForm({ name: "名前だけ" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields).toMatchObject({ name: "名前だけ", contact_name: null, login_email: null, plan: null, service_status: null, contact_email: null });
      expect(Object.keys(missingForRegistration(r.fields)).sort()).toEqual(["contactName", "loginEmail", "serviceStatus"]);
    }
    const base = { contact_name: "担当", login_email: "a@example.test", plan: null };
    expect(missingForRegistration({ ...base, service_status: "pending" })).toEqual({});
    expect(Object.keys(missingForRegistration({ ...base, service_status: "test" }))).toEqual(["plan"]);
  });

  it("新しい店舗の登録種別に無料提供は無い。プランが未定のときは、機能ごとの利用許可を保存しない", () => {
    expect(parseDraftForm({ name: "x", serviceStatus: "complimentary" }).ok).toBe(false);
    const noPlan = parseDraftForm({ name: "x", serviceStatus: "pending", featureOverrides: { blog: "deny" } });
    expect(noPlan.ok && noPlan.fields.feature_overrides).toEqual({});
  });
  it("形式の誤りは項目ごと。連絡用メールがログイン用と同じなら保存しない", () => {
    const bad = parseDraftForm({ name: "x", loginEmail: "nope", contactEmailMode: "other", contactEmail: "", plan: "gold" });
    expect(bad.ok).toBe(false);
    const same = parseDraftForm({ name: "x", loginEmail: "A@example.test", contactEmailMode: "other", contactEmail: "a@example.test" });
    expect(same.ok && same.fields.contact_email).toBe(null);
    const overrides = parseDraftForm({ name: "x", plan: "salonpack", featureOverrides: { blog: "deny" } });
    expect(overrides.ok && overrides.fields.feature_overrides).toEqual({ blog: "deny" });
  });
});

describe("変更履歴の新しい種類", () => {
  const base: AuditEntry = { id: "1", occurredAt: "2026-10-14T00:00:00Z", actorKind: "operator", actorEmail: "ops@example.test", actorLabel: null, target: "", before: null, after: null, note: null };
  const ctx = { rules: RULES, plan: "reviews" as const };
  it("利用区分・登録・案内の送信を、言葉で出す(機械向けの値は出さない)", () => {
    expect(describeAuditEntry({ ...base, target: "service_status", before: "pending", after: "complimentary" }, ctx).change).toBe("利用区分: お申し込み手続き中 → 無料提供");
    expect(describeAuditEntry({ ...base, target: "registration", after: { source: "operator", plan: "salonpack", service_status: "test" } }, ctx).change).toBe(
      "運営が店舗を本登録(契約プラン: SalonPack・テスト用)",
    );
    // 通常登録のプランは案内予定のプラン(契約ではない)。未定もある
    expect(describeAuditEntry({ ...base, target: "registration", after: { source: "operator", plan: "salonpack", service_status: "pending" } }, ctx).change).toBe(
      "運営が店舗を本登録(案内予定のプラン: SalonPack・お申し込み手続き中)",
    );
    expect(describeAuditEntry({ ...base, target: "registration", after: { source: "operator", plan: null, service_status: "pending" } }, ctx).change).toBe(
      "運営が店舗を本登録(プラン未定・お申し込み手続き中)",
    );
    // お客様の登録はプランを決めていない(0025 の記録の口コミプランは仮の値)
    for (const plan of [null, "reviews"]) {
      const own = describeAuditEntry({ ...base, actorKind: "owner", actorEmail: null, target: "registration", after: { source: "self_signup", plan, service_status: "pending" } }, ctx);
      expect(own).toMatchObject({ actor: "変更者: お客様(店舗のオーナー)", change: "お客様が店舗を登録(プラン未定・お申し込み手続き中)" });
    }
    expect(describeAuditEntry({ ...base, target: "contract_plan", after: { plan: "salonpack", service_status: "test" } }, ctx).change).toBe(
      "利用開始: 契約プランはSalonPack(テスト用)",
    );
    expect(describeAuditEntry({ ...base, target: "invitation", after: { kind: "invite", result: "accepted" } }, ctx).change).toBe("招待のメール: 送信を受け付けました");
    expect(describeAuditEntry({ ...base, target: "invitation", after: { kind: "salon_notice", result: "failed", error: "rate_limited" } }, ctx).change).toMatch(
      /^店舗登録のお知らせ: 送信できませんでした/,
    );
    const migration = describeAuditEntry(
      { ...base, actorKind: "sql", actorEmail: null, actorLabel: "migration:0025", target: "service_status", after: "complimentary", note: "0025 の適用時点で存在した店舗を、無償提供として移行" },
      ctx,
    );
    expect(migration).toMatchObject({ actor: "変更者: 移行(0025)", change: "利用区分を無料提供に設定" });
  });
});
