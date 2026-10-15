import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import type { OwnerSalon } from "@/lib/types";
import type { FeatureKey } from "@/lib/features/registry";
import type { FeatureLifecycle, OverrideMode } from "@/lib/features/entitlements";
import type { GbpInbox } from "@/lib/gbp/inbox";
import { entitlementsFor } from "../../helpers/entitlements";

// 届いた口コミの入口(計画 第2版 §3-8・§6「非公開でマージするときに保証する条件」・§3-A・§3-6)。
//   ・準備中(機能カタログの coming_soon)・店舗ごとの許可が無い・GOOGLE_REVIEWS_OAUTH_ENABLED が空、のどれでも、
//     画面の操作・AI の生成・投稿・店舗の選択・連携の開始が、口コミの処理(Google・DB)に届かない
//   ・AI の返信案は、作っている間に世代(連携・店舗)が変わったら返さない。投稿者名は渡さない
//   ・連携の前の同意が無いと、連携を始めない・同意を記録しない(同意の確認そのものは lib/gbp/inbox.ts。localdb で確かめる)
//   ・貼り付け型の入口は無い
// DB・Google・OpenAI には接続しない(店舗の解決・利用権限の読み込み・口コミの処理を差し替える)。

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ redirect, notFound }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let currentSalon: OwnerSalon | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentSalon: async () => currentSalon,
  getAuthedUser: async () => ({ id: "user-1" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ fake: "admin" }) }));

let overrides: Partial<Record<FeatureKey, OverrideMode>> = {};
let lifecycle: Partial<Record<FeatureKey, FeatureLifecycle>> = {};
// 利用開始待ちの店舗の判定は DB(0025 の salon_feature_access)が返す(理由 service_pending)。その結果を写す。
let servicePending = false;
vi.mock("@/lib/features/loadEntitlements", () => ({
  loadSalonEntitlements: async () => {
    const e = entitlementsFor(currentSalon?.plan ?? "reviews", { overrides, lifecycle });
    if (servicePending) for (const key of Object.keys(e) as FeatureKey[]) e[key] = { ...e[key]!, allowed: false, reason: "service_pending" };
    return e;
  },
}));

// 口コミの処理。入口の判定を通ったときだけ呼ばれるはず(フラグに関係なく返して、入口の判定だけを確かめる)。
const inbox = {
  getConnection: vi.fn(),
  recordConsent: vi.fn(async () => ({ ok: true as const, value: undefined })),
  hasConsent: vi.fn(async () => false),
  selectLocation: vi.fn(async () => ({ ok: true as const, value: undefined })),
  beginLocationChange: vi.fn(async () => ({ ok: true as const, value: undefined })),
  listReviews: vi.fn(async () => ({ kind: "not_connected" as const })),
  getReview: vi.fn(),
  refresh: vi.fn(async () => ({ ok: true as const, value: { lastCheckedAt: "2026-10-15T00:00:00Z", syncIncomplete: false } })),
  checkReview: vi.fn(),
  setSeen: vi.fn(async () => ({ ok: true as const, value: undefined })),
  saveDraft: vi.fn(async () => ({ ok: true as const, value: { savedAt: "2026-10-15T00:00:00Z" } })),
  getReplyInput: vi.fn(),
  isCurrent: vi.fn(async () => true),
  submitReply: vi.fn(async () => ({ kind: "accepted" as const, review: null, replayed: false })),
  dismissReplyOperation: vi.fn(async () => ({ ok: true as const, value: undefined })),
} satisfies Record<keyof GbpInbox, unknown>;
let inboxAvailable = true;
vi.mock("@/lib/gbp/runtime", () => ({ getGbpInbox: () => (inboxAvailable ? inbox : null) }));

const generateReplyForSalon = vi.fn();
vi.mock("@/lib/replyGeneration/service", () => ({ generateReplyForSalon }));

type Binding = { feature: "gmail" | "gbp"; accountEmail: string | null; account: { googleSub: string; email: string | null } };
let bindings: Binding[] = [];
vi.mock("@/lib/google/db/bindings", () => ({ listSalonGoogleBindings: async () => bindings, unbindGoogleFeatures: vi.fn() }));
const startGoogleConnect = vi.fn<(params: Record<string, unknown>, deps: unknown) => Promise<string>>(async () => "https://accounts.google.com/o/oauth2/v2/auth?x");
vi.mock("@/lib/google/oauthFlow", () => ({ startGoogleConnect, GoogleConnectInputError: class extends Error {} }));
vi.mock("@/lib/google/runtime", () => ({ getGoogleFlowDeps: () => ({}) }));

const REVIEW = "20000000-0000-4000-8000-000000000001";
const LOCATION = "30000000-0000-4000-8000-000000000001";
const OTHER_LOCATION = "30000000-0000-4000-8000-000000000002";
const OP = "40000000-0000-4000-8000-000000000001";

function salon(plan: "reviews" | "salonpack"): OwnerSalon {
  return {
    id: "salon-1",
    ownerId: "owner-1",
    name: "テストサロン",
    slug: "test",
    googleReviewUrl: null,
    description: null,
    businessType: null,
    onboardingCompleted: true,
    plan,
    serviceStatus: "complimentary",
    registrationSource: "existing",
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  } as OwnerSalon;
}

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw e;
  }
  throw new Error("redirect されませんでした");
}

/** 店舗ごとに許可し、提供中にし、フラグも有効にした状態(使える)。 */
function allowFully() {
  lifecycle = { google_reviews: "available" };
  overrides = { google_reviews: "allow" };
  vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "1");
}

const allInboxCalls = () => Object.values(inbox).reduce((n, fn) => n + (fn as ReturnType<typeof vi.fn>).mock.calls.length, 0);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack");
  vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "");
  vi.clearAllMocks();
  currentSalon = salon("reviews");
  overrides = {};
  lifecycle = {};
  bindings = [];
  inboxAvailable = true;
  servicePending = false;
});

async function loadActions() {
  const inboxActions = await import("@/app/dashboard/reviews/google/inboxActions");
  const actions = await import("@/app/dashboard/reviews/google/actions");
  const settings = await import("@/app/dashboard/reviews/settings/actions");
  return { ...inboxActions, ...actions, ...settings };
}

async function callEveryEntry() {
  const a = await loadActions();
  const results: unknown[] = [];
  results.push(await a.listReviewsAction({ filter: "unreplied", rating: "all", sort: "newest" }, null));
  results.push(await a.refreshReviewsAction());
  results.push(await a.checkReviewAction(REVIEW));
  results.push(await a.setReviewSeenAction(REVIEW, true));
  results.push(await a.saveReviewDraftAction(REVIEW, "下書き"));
  results.push(await a.submitReplyAction({ reviewId: REVIEW, opId: OP, action: "upsert", text: "ありがとうございます", expectedReply: null }));
  results.push(await a.dismissReplyOperationAction(REVIEW));
  results.push(await a.selectLocationAction({ locationName: "locations/1" }));
  results.push(await a.generateReplyForReviewAction({ reviewId: REVIEW, locationId: LOCATION }));
  results.push(await a.saveReplySettingsAction({} as never));
  const connect = await redirectOf(() => a.startReviewsConnectAction(form({ mode: "connect", consent: "yes" })));
  const change = await redirectOf(() => a.changeLocationAction(form({ confirm: "yes" })));
  const agree = await redirectOf(() => a.agreeReviewsConsentAction(form({ consent: "yes" })));
  return { results, connect, change, agree };
}

describe("非公開のままの入口(計画 第2版 §6)", () => {
  it.each([
    ["準備中(coming_soon)で、店舗ごとに許可しても", () => {
      overrides = { google_reviews: "allow" };
      vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "1");
    }],
    ["提供中でも、店舗ごとの許可が無ければ(プランの標準は使えない)", () => {
      lifecycle = { google_reviews: "available" };
      vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "1");
    }],
    ["提供中・許可済みでも、GOOGLE_REVIEWS_OAUTH_ENABLED が空なら", () => {
      lifecycle = { google_reviews: "available" };
      overrides = { google_reviews: "allow" };
    }],
    ["使える店舗でも、口コミの処理を組み立てられなければ(鍵が無いなど)", () => {
      allowFully();
      inboxAvailable = false;
    }],
  ])("%s、どの操作も口コミの処理・AI・Google の連携に届かない", async (_label, setup) => {
    setup();
    const { results, connect, change, agree } = await callEveryEntry();
    expect(allInboxCalls()).toBe(0);
    expect(agree).toBe("/dashboard/reviews/google?google=not_available");
    expect(generateReplyForSalon).not.toHaveBeenCalled();
    expect(startGoogleConnect).not.toHaveBeenCalled();
    expect(connect).toBe("/dashboard/reviews/google?google=not_available");
    expect(change).toBe("/dashboard/reviews/settings");
    // 投稿は「送っていない」と分かる形で返す(結果不明にしない)
    expect(results[5]).toMatchObject({ kind: "unavailable" });
    expect(results[0]).toMatchObject({ kind: "error" });
  });

  it("SalonPack プランでも同じ(プランの標準は使えない)", async () => {
    currentSalon = salon("salonpack");
    vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "1");
    lifecycle = { google_reviews: "available" };
    await callEveryEntry();
    expect(allInboxCalls()).toBe(0);
  });

  it("利用開始待ちの店舗は、許可があっても使えない", async () => {
    allowFully();
    currentSalon = { ...salon("reviews"), serviceStatus: "pending" } as OwnerSalon;
    servicePending = true;
    await callEveryEntry();
    expect(allInboxCalls()).toBe(0);
  });

  it("店舗ごとに許可し、提供中で、フラグが有効なら使える(その店舗の ID で呼ぶ)", async () => {
    allowFully();
    const a = await loadActions();
    await a.listReviewsAction({ filter: "attention", rating: "all", sort: "newest" }, null);
    expect(inbox.listReviews).toHaveBeenCalledWith({ salonId: "salon-1", userId: "user-1" }, { filter: "attention", rating: "all", sort: "newest" }, null);
  });

  it("貼り付け型の入口は無い(画面・Server Action)", async () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, "app/dashboard/reviews/google/paste"))).toBe(false);
    expect(existsSync(path.join(root, "components/reviews/reply/PasteReplyTool.tsx"))).toBe(false);
    const actions = await import("@/app/dashboard/reviews/google/actions");
    expect(Object.keys(actions)).toEqual(["generateReplyForReviewAction"]);
  });
});

describe("AI の返信案(計画 第2版 §3-6・§3-A)", () => {
  beforeEach(() => {
    allowFully();
    inbox.getReplyInput.mockResolvedValue({ ok: true, value: { text: "とても良かったです。", rating: 5, locationId: LOCATION } });
    generateReplyForSalon.mockResolvedValue({ ok: true, reply: "ありがとうございます。", warnings: [], careful: false });
  });

  it("本文と★だけを渡し(投稿者名は渡さない)、作り終えたら同じ世代かを確かめてから返す", async () => {
    const { generateReplyForReviewAction } = await loadActions();
    const res = await generateReplyForReviewAction({ reviewId: REVIEW, locationId: LOCATION });
    expect(res).toMatchObject({ ok: true, reply: "ありがとうございます。", reviewId: REVIEW, locationId: LOCATION });
    const [input, deps] = generateReplyForSalon.mock.calls[0];
    expect(input).toMatchObject({ reviewText: "とても良かったです。", rating: 5, regenerate: false });
    expect(Object.keys(input).sort()).toEqual(["previousReply", "rating", "regenerate", "reviewText", "salon"]);
    expect(deps.mock).toBe(false); // 架空の Google の検証のときだけ架空の文章
    expect(inbox.isCurrent).toHaveBeenCalledWith({ salonId: "salon-1", userId: "user-1" }, REVIEW, LOCATION);
  });

  it("作っている間に連携・店舗が変わったら、返信案を返さない", async () => {
    inbox.isCurrent.mockResolvedValueOnce(false);
    const { generateReplyForReviewAction } = await loadActions();
    const res = await generateReplyForReviewAction({ reviewId: REVIEW, locationId: LOCATION });
    expect(res).toMatchObject({ ok: false, stale: true, reviewId: REVIEW });
    expect(res).not.toHaveProperty("reply");
  });

  it("画面の世代と、口コミの今の世代が違えば、作らない", async () => {
    const { generateReplyForReviewAction } = await loadActions();
    const res = await generateReplyForReviewAction({ reviewId: REVIEW, locationId: OTHER_LOCATION });
    expect(res).toMatchObject({ ok: false, stale: true });
    expect(generateReplyForSalon).not.toHaveBeenCalled();
  });

  it("作っている間に利用できなくなったら、返信案を返さない", async () => {
    generateReplyForSalon.mockImplementationOnce(async () => {
      overrides = { google_reviews: "deny" };
      return { ok: true, reply: "ありがとうございます。", warnings: [], careful: false };
    });
    const { generateReplyForReviewAction } = await loadActions();
    const res = await generateReplyForReviewAction({ reviewId: REVIEW, locationId: LOCATION });
    expect(res).toMatchObject({ ok: false });
    expect(res).not.toHaveProperty("reply");
  });

  it("★の無い口コミは作らない(直接入力を案内する)", async () => {
    inbox.getReplyInput.mockResolvedValueOnce({ ok: true, value: { text: "x", rating: null, locationId: LOCATION } });
    const { generateReplyForReviewAction } = await loadActions();
    const res = await generateReplyForReviewAction({ reviewId: REVIEW, locationId: LOCATION });
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(generateReplyForSalon).not.toHaveBeenCalled();
  });
});

describe("連携の開始・店舗の選択と同意(計画 第2版 §2 操作の流れ)", () => {
  beforeEach(() => allowFully());

  it("同意のチェックが無ければ、連携を始めない", async () => {
    const { startReviewsConnectAction } = await loadActions();
    expect(await redirectOf(() => startReviewsConnectAction(form({ mode: "connect" })))).toBe("/dashboard/reviews/google?google=consent_required");
    expect(inbox.recordConsent).not.toHaveBeenCalled();
    expect(startGoogleConnect).not.toHaveBeenCalled();
  });

  it("同意を記録してから、口コミの権限だけを求め、戻り先は届いた口コミ", async () => {
    const { startReviewsConnectAction } = await loadActions();
    const url = await redirectOf(() => startReviewsConnectAction(form({ mode: "connect", consent: "yes" })));
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(inbox.recordConsent).toHaveBeenCalledTimes(1);
    expect(startGoogleConnect.mock.calls[0][0]).toMatchObject({ features: ["gbp"], purpose: "connect", returnTo: "reviews", expectedGoogleSub: null });
  });

  it("予約メールと同じアカウントなら、そのアカウントに権限を追加する(Gmail の結び付けは変えない)", async () => {
    bindings = [{ feature: "gmail", accountEmail: "salon@example.test", account: { googleSub: "sub-gmail", email: "salon@example.test" } }];
    const { startReviewsConnectAction } = await loadActions();
    await redirectOf(() => startReviewsConnectAction(form({ mode: "same_account", consent: "yes" })));
    expect(startGoogleConnect.mock.calls[0][0]).toMatchObject({ features: ["gbp"], purpose: "add_scope", expectedGoogleSub: "sub-gmail", returnTo: "reviews" });
  });

  it("店舗の選択では同意を記録しない(同意の無い店舗は、口コミの処理が選択を断る)", async () => {
    const { selectLocationAction } = await loadActions();
    // 画面から consent: true が来ても、ここでは記録しない(同意は同意の操作だけで記録する)
    expect(await selectLocationAction({ locationName: "locations/1", consent: true } as never)).toEqual({ ok: true, value: undefined });
    expect(inbox.recordConsent).not.toHaveBeenCalled();
    expect(inbox.selectLocation).toHaveBeenCalledWith({ salonId: "salon-1", userId: "user-1" }, "locations/1");
  });

  it("共通の Google 連携の画面から連携した店舗の同意:チェックが無ければ記録しない。あれば記録して届いた口コミへ戻る", async () => {
    const { agreeReviewsConsentAction } = await loadActions();
    expect(await redirectOf(() => agreeReviewsConsentAction(form({})))).toBe("/dashboard/reviews/google?google=consent_required");
    expect(inbox.recordConsent).not.toHaveBeenCalled();
    expect(await redirectOf(() => agreeReviewsConsentAction(form({ consent: "yes" })))).toBe("/dashboard/reviews/google");
    expect(inbox.recordConsent).toHaveBeenCalledWith({ salonId: "salon-1", userId: "user-1" });
    // 同意の操作は、Google にも口コミの処理(取得・選択)にもつながない
    expect(startGoogleConnect).not.toHaveBeenCalled();
    expect(inbox.selectLocation).not.toHaveBeenCalled();
    expect(inbox.refresh).not.toHaveBeenCalled();
  });

  it("ロケーションの名前の形が違えば選ばない", async () => {
    const { selectLocationAction } = await loadActions();
    expect(await selectLocationAction({ locationName: "accounts/1/locations/1" })).toMatchObject({ ok: false });
    expect(inbox.selectLocation).not.toHaveBeenCalled();
  });

  it("店舗の変更は、確認のチェックが無ければ始めない", async () => {
    const { changeLocationAction } = await loadActions();
    expect(await redirectOf(() => changeLocationAction(form({})))).toBe("/dashboard/reviews/settings?location=confirm_required");
    expect(inbox.beginLocationChange).not.toHaveBeenCalled();
    expect(await redirectOf(() => changeLocationAction(form({ confirm: "yes" })))).toBe("/dashboard/reviews/google");
    expect(inbox.beginLocationChange).toHaveBeenCalledTimes(1);
  });
});

describe("投稿の予期しない失敗", () => {
  it("どこまで進んだか分からないときは、結果不明として返す(成功・失敗と言わない)", async () => {
    allowFully();
    inbox.submitReply.mockRejectedValueOnce(new Error("boom"));
    const { submitReplyAction } = await loadActions();
    const res = await submitReplyAction({ reviewId: REVIEW, opId: OP, action: "upsert", text: "ありがとうございます", expectedReply: null });
    expect(res.kind).toBe("unknown");
    expect((res as { message: string }).message).toContain("Googleで確認する");
  });
});
