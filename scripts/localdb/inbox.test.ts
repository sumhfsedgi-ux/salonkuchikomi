// 届いた口コミのサーバー処理(lib/gbp/inbox.ts)を、ローカルの PostgreSQL の本物の SQL(0027〜0030)と
// 架空の Google の口コミの API(lib/gbp/simulated.ts)でまとめて確かめる(npm run test:localdb)。値はすべて架空。
//   - 同意の前は、店舗の候補・口コミの取得・保存・AI の入力・投稿のどれも始まらない(同意の版が変わったときも)
//   - 連携 → 店舗の選択 → 初回の取り込み → 一覧(未返信・確認が必要・返信済み)・Google の値・新着
//   - 返信の投稿・結果不明・取り直しの照合(結果不明は、送った内容が見えるまで続く。その間は、送るのをやめる・
//     送り直し・新しい送信・削除を受け付けない。遅れて最初の返信が反映される場合も)
//   - 連携・店舗の変更や利用不可への変更と、取り込み・送信が重なったとき(計画 第2版 §3-A)
//   - 403 の分類(口コミの権限不足のときだけ口コミの結び付けに記録し、Gmail・アカウントの状態は変えない。§3-B)
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { createSalon, type SalonFixture } from "./fixtures";
import { createLocalRpcClient } from "./rpcClient";
import { createRpcGbpStore } from "@/lib/gbp/supabaseStore";
import { createGbpInbox, GBP_MIN_REFRESH_INTERVAL_MS, type GbpInbox, type GbpInboxDeps } from "@/lib/gbp/inbox";
import { createSimulatedGbp, simulatedGbpToken, type SimulatedGbp } from "@/lib/gbp/simulated";
import { simulatedGbpUsers, SIM_OWNER_SUB } from "@/lib/gbp/dev/simulatedFixtures";
import { GbpApiError } from "@/lib/gbp/apiClient";
import { GbpTokenError, type GbpAccess, type GbpBinding } from "@/lib/gbp/access";
import { DEFAULT_LIST_QUERY } from "@/lib/googleReviews/query";

const DB = "salonpack_localdb_inbox";
const SECRET = "localdb-test-review-key-secret-0000000000000";
const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
let sql: Sql;

function accessFor(db: Sql): GbpAccess {
  return {
    async binding(salonId): Promise<GbpBinding | null> {
      const [b] = await db`
        select b.google_account_id, a.google_sub, a.email, a.auth_state, b.scope_missing_since, a.granted_scopes,
               b.gbp_selection_state, b.account_bound_at
          from public.salon_google_bindings b join public.google_accounts a on a.id = b.google_account_id
         where b.salon_id = ${salonId} and b.feature = 'gbp'`;
      if (!b) return null;
      return {
        googleAccountId: b.google_account_id,
        googleSub: b.google_sub,
        email: b.email,
        authState: b.auth_state,
        scopeMissing: b.scope_missing_since !== null,
        scopeGranted: (b.granted_scopes ?? []).includes(GBP_SCOPE),
        selectionState: b.gbp_selection_state === "selected" ? "selected" : "selection_pending",
        accountBoundAt: new Date(b.account_bound_at).toISOString(),
      };
    },
    async accessToken(binding) {
      return simulatedGbpToken(binding.googleSub, "local-access-token");
    },
    async markScopeMissing(salonId, scopes) {
      await db`select public.google_mark_binding_scope(${salonId}, 'gbp', true, ${scopes})`;
    },
  };
}

interface World {
  salon: SalonFixture;
  accountId: string;
  ctx: { salonId: string; userId: string };
  sim: SimulatedGbp;
  inbox: GbpInbox;
  canWrite: { value: boolean };
  /** 同じ店舗・同じ架空の Google で、設定だけを変えた処理を作る。 */
  make: (extra: Partial<GbpInboxDeps>) => GbpInbox;
}

async function world(opts: { bindGmail?: boolean } = {}): Promise<World> {
  const salon = await createSalon(sql, { plan: "salonpack" });
  const accountId = randomUUID();
  await sql`
    insert into public.google_accounts (id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv,
                                        refresh_token_tag, key_version, granted_scopes)
    values (${accountId}, ${`client-${accountId.slice(0, 8)}`}, ${SIM_OWNER_SUB}, 'owner@example.test', 'c', 'i', 't', 'v1',
            ${["openid", "email", GBP_SCOPE, GMAIL_SCOPE]})`;
  await sql`select * from public.google_bind_features(${salon.salonId}, ${accountId}, ${opts.bindGmail ? ["gbp", "gmail"] : ["gbp"]}, null, ${salon.userId}, ${[GBP_SCOPE, GMAIL_SCOPE]})`;
  await sql`update public.feature_catalog set lifecycle = 'available' where feature_key = 'google_reviews'`;
  await sql`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${salon.salonId}, 'reviews', 'allow')`;
  const sim = createSimulatedGbp({ users: simulatedGbpUsers() });
  const canWrite = { value: true };
  const make = (extra: Partial<GbpInboxDeps>) =>
    createGbpInbox({
      store: createRpcGbpStore(createLocalRpcClient(sql)),
      api: sim.api,
      access: accessFor(sql),
      reviewKeySecret: SECRET,
      canWrite: () => canWrite.value,
      minRefreshIntervalMs: 0,
      ...extra,
    });
  return { salon, accountId, ctx: { salonId: salon.salonId, userId: salon.userId }, sim, inbox: make({}), canWrite, make };
}

async function connected(w: World, location = "locations/sim-101") {
  await w.inbox.recordConsent(w.ctx);
  const r = await w.inbox.selectLocation(w.ctx, location);
  expect(r).toEqual({ ok: true, value: undefined });
}

async function items(w: World, filter: string) {
  const r = await w.inbox.listReviews(w.ctx, { ...DEFAULT_LIST_QUERY, filter: filter as never }, null);
  if (r.kind !== "ok") throw new Error(`list: ${r.kind}`);
  return r;
}

const idOf = async (w: World, commentPart: string) => (await items(w, "all")).items.find((i) => i.comment.includes(commentPart))!.id;
const R1 = "accounts/sim-1/locations/sim-101/reviews/sim-r1";

beforeAll(async () => {
  sql = await createDatabase(DB);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
  // 店舗のロケーションは店舗をまたいで1つなので、テストごとに前の店舗の結び付けを外して選び直せるようにする。
});

async function releaseLocations() {
  await sql`update public.gbp_locations set status = 'disconnected' where status = 'active'`;
}

describe("連携 → 店舗の選択 → 一覧", () => {
  it("未連携 → 選択待ち(選べない店舗を区別)→ 選ぶと初回の取り込みが済み、未返信・確認が必要・返信済みに分かれる", async () => {
    await releaseLocations();
    const w = await world();
    // 同意の前は、店舗の候補も取らない(Google を呼ばない)
    expect(await w.inbox.getConnection(w.ctx)).toEqual({ kind: "consent_required", googleEmail: "owner@example.test" });
    expect(w.sim.calls).toEqual([]);
    await w.inbox.recordConsent(w.ctx);
    const before = await w.inbox.getConnection(w.ctx);
    expect(before.kind).toBe("selecting");
    if (before.kind !== "selecting") throw new Error();
    const locations = before.accounts[0].locations;
    expect(locations.map((l) => [l.locationName, l.unavailableReason])).toEqual([
      ["locations/sim-101", null],
      ["locations/sim-102", null],
      ["locations/sim-103", "unverified"],
    ]);
    await connected(w);
    expect((await w.inbox.getConnection(w.ctx)).kind).toBe("connected");
    const all = await items(w, "all");
    expect(all.items).toHaveLength(4);
    expect([all.summary.averageRating, all.summary.totalReviewCount, all.summary.initialSyncDone, all.summary.newCount]).toEqual([3.5, 4, true, 0]);
    expect((await items(w, "unreplied")).items.map((i) => i.comment)).toEqual(["(架空の口コミ)カットの相談にていねいに乗ってもらえました。", "(架空の口コミ)写真つき。"]);
    expect((await items(w, "attention")).items.map((i) => i.reply?.state)).toEqual(["REJECTED"]);
    expect((await items(w, "replied")).items.map((i) => i.reply?.state)).toEqual(["APPROVED"]);
  });

  it("更新で新しく見つけた口コミだけが新着(初回の分・編集は新着にしない)", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    w.sim.editReview("accounts/sim-1/locations/sim-101/reviews/sim-r4", "(架空の口コミ)写真つき。編集しました。");
    const at = new Date().toISOString();
    w.sim.addReview("locations/sim-101", { name: "accounts/sim-1/locations/sim-101/reviews/sim-new", starRating: "FIVE", comment: "(架空)新しい口コミ", createTime: at, updateTime: at });
    const r = await w.inbox.refresh(w.ctx);
    expect(r.ok).toBe(true);
    const list = await items(w, "new");
    expect(list.items.map((i) => i.comment)).toEqual(["(架空)新しい口コミ"]);
    expect(list.summary.newCount).toBe(1);
    await w.inbox.setSeen(w.ctx, list.items[0].id, true);
    expect((await items(w, "all")).summary.newCount).toBe(0);
  });
});

describe("同意(共通の Google 連携の画面から連携した場合・同意の版が変わった場合)", () => {
  it("同意を記録するまで、店舗の候補・口コミの取得・保存・一覧のどれも始まらない(Google を呼ばない)", async () => {
    await releaseLocations();
    const w = await world();
    // 口コミの結び付けはある(共通の Google 連携の画面から連携した)が、同意の記録が無い
    expect((await w.inbox.getConnection(w.ctx)).kind).toBe("consent_required");
    expect(await w.inbox.selectLocation(w.ctx, "locations/sim-101")).toMatchObject({ ok: false });
    expect(await w.inbox.refresh(w.ctx)).toMatchObject({ ok: false });
    expect(await w.inbox.listReviews(w.ctx, DEFAULT_LIST_QUERY, null)).toMatchObject({ kind: "error" });
    expect(w.sim.calls).toEqual([]);
    const [n] = await sql`
      select (select count(*) from public.gbp_locations where salon_id = ${w.salon.salonId})::int as locations,
             (select count(*) from public.gbp_review_index where salon_id = ${w.salon.salonId})::int as reviews`;
    expect(n).toEqual({ locations: 0, reviews: 0 });
  });

  it("同意の版が変わったら、記録し直すまで取得・確認・AI の入力・下書き・投稿を止める(Google を呼ばない)", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const list = await items(w, "all");
    const id = list.items.find((i) => i.comment.includes("カットの相談"))!.id;
    const next = w.make({ consentVersion: "gbp-connect-test-next" });
    const callsBefore = w.sim.calls.length;

    expect((await next.getConnection(w.ctx)).kind).toBe("consent_required");
    expect(await next.listReviews(w.ctx, DEFAULT_LIST_QUERY, null)).toMatchObject({ kind: "error" });
    expect(await next.refresh(w.ctx)).toMatchObject({ ok: false });
    expect(await next.checkReview(w.ctx, id)).toMatchObject({ ok: false });
    expect((await next.getReview(w.ctx, id)).kind).toBe("not_found");
    expect(await next.getReplyInput(w.ctx, id)).toMatchObject({ ok: false });
    expect(await next.isCurrent(w.ctx, id, list.summary.locationId)).toBe(false);
    expect(await next.saveDraft(w.ctx, id, "下書き")).toMatchObject({ ok: false });
    expect(await next.setSeen(w.ctx, id, true)).toMatchObject({ ok: false });
    const sent = await next.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "返信", expectedReply: null });
    expect(sent.kind).toBe("unavailable");
    expect(w.sim.calls.length).toBe(callsBefore);
    expect(w.sim.replyOf(R1)).toBeNull();

    await next.recordConsent(w.ctx);
    expect((await next.getConnection(w.ctx)).kind).toBe("connected");
  });
});


describe("返信(§2)", () => {
  it("受け付けは「送信結果を確認中」、Google で確かめると審査中(返信済み)", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    const sent = await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "ありがとうございます", expectedReply: null });
    expect(sent.kind).toBe("accepted");
    if (sent.kind !== "accepted") throw new Error();
    expect([sent.review?.operation, sent.review?.bucket]).toEqual(["sent_checking", "attention"]);
    const checked = await w.inbox.checkReview(w.ctx, id);
    expect(checked.ok && [checked.value.operation, checked.value.bucket, checked.value.reply?.state]).toEqual(["none", "replied", "PENDING"]);
  });

  it("応答が失われた(結果不明)ら「確認が必要」で、未返信に入らない。取り直して反映が分かれば確認済み", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    w.sim.loseNextResponse("reply", new GbpApiError("timeout"));
    const sent = await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "ありがとうございます", expectedReply: null });
    expect(sent.kind).toBe("unknown");
    expect((await items(w, "unreplied")).items.map((i) => i.id)).not.toContain(id);
    expect((await items(w, "attention")).items.find((i) => i.id === id)?.operation).toBe("unknown");
    const checked = await w.inbox.checkReview(w.ctx, id);
    expect(checked.ok && checked.value.bucket).toBe("replied");
  });

  it("このデプロイで書き込みが止められていれば送らない", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    w.canWrite.value = false;
    const id = await idOf(w, "カットの相談");
    const sent = await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "ありがとうございます", expectedReply: null });
    expect(sent.kind).toBe("unavailable");
    expect(w.sim.replyOf(R1)).toBeNull();
  });

  it("結果が分からない間は、送るのをやめる・同じ操作の送り直し・別の返信・削除を受け付けず、Google に送らない", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    const writes = () => w.sim.calls.filter((c) => c === "reply" || c === "delete_reply").length;
    const opId = randomUUID();
    w.sim.failNext("reply", new GbpApiError("timeout"));
    const sent = await w.inbox.submitReply(w.ctx, { reviewId: id, opId, action: "upsert", text: "最初の返信", expectedReply: null });
    expect(sent.kind).toBe("unknown");
    expect(writes()).toBe(1);

    expect(await w.inbox.dismissReplyOperation(w.ctx, id)).toMatchObject({ ok: false });
    expect(await w.inbox.submitReply(w.ctx, { reviewId: id, opId, action: "upsert", text: "最初の返信", expectedReply: null })).toMatchObject({ kind: "busy" });
    expect(await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "別の返信", expectedReply: null })).toMatchObject({
      kind: "busy",
    });
    expect(await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "delete", text: null, expectedReply: null })).toMatchObject({
      kind: "busy",
    });
    expect(writes()).toBe(1);
    // 確認しても、送った内容が見えなければ結果不明のまま。時間がたっても変わらない
    let checked = await w.inbox.checkReview(w.ctx, id);
    expect(checked.ok && [checked.value.operation, checked.value.bucket]).toEqual(["unknown", "attention"]);
    await sql`update public.gbp_reply_operations set completed_at = now() - interval '1 day', last_attempt_at = now() - interval '1 day'
               where salon_id = ${w.salon.salonId}`;
    checked = await w.inbox.checkReview(w.ctx, id);
    expect(checked.ok && [checked.value.operation, checked.value.bucket]).toEqual(["unknown", "attention"]);
    expect(await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "別の返信", expectedReply: null })).toMatchObject({
      kind: "busy",
    });
    expect(writes()).toBe(1);
  });

  it("遅れて最初の返信が反映される:見えるまでは結果不明で何も送らず、見えたら確認済みになり、そこで初めて置き換えられる", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    const writes = () => w.sim.calls.filter((c) => c === "reply" || c === "delete_reply").length;
    // 時間切れで応答が無く、Google への反映はあとから起きる
    w.sim.deferNextWrite("reply");
    const sent = await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "最初の返信", expectedReply: null });
    expect(sent.kind).toBe("unknown");
    let checked = await w.inbox.checkReview(w.ctx, id);
    expect(checked.ok && checked.value.operation).toBe("unknown");
    expect(w.sim.replyOf(R1)).toBeNull();
    // 反映を確認できない間の別の返信は送らない(送っていれば、遅れて届いた最初の返信と入れ替わるおそれがある)
    expect((await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "別の返信", expectedReply: null })).kind).toBe("busy");
    expect(writes()).toBe(1);
    // 最初の返信が遅れて反映された
    expect(w.sim.applyDeferredWrites()).toBe(1);
    expect(w.sim.replyOf(R1)?.comment).toBe("最初の返信");
    checked = await w.inbox.checkReview(w.ctx, id);
    expect(checked.ok && [checked.value.operation, checked.value.bucket, checked.value.reply?.comment]).toEqual(["none", "replied", "最初の返信"]);
    // 確認済みになったので、置き換えられる(見ていた返信=最初の返信を基準に送る)
    const replaced = await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "直した返信", expectedReply: "最初の返信" });
    expect(replaced.kind).toBe("accepted");
    expect(w.sim.replyOf(R1)?.comment).toBe("直した返信");
  });

  it("「送るのをやめる」は Google に何も送らず、送れなかったと分かっている記録だけを閉じる(未返信のまま)", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    // Google が拒否した(反映されていないと分かる)
    w.sim.failNext("reply", new GbpApiError("permission_denied"));
    const sent = await w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "最初の返信", expectedReply: null });
    expect(sent.kind).toBe("failed");
    const failed = await w.inbox.getReview(w.ctx, id);
    expect(failed.kind === "ok" && [failed.review.operation, failed.review.bucket]).toEqual(["send_failed", "unreplied"]);
    const callsBefore = w.sim.calls.length;
    expect(await w.inbox.dismissReplyOperation(w.ctx, id)).toEqual({ ok: true, value: undefined });
    expect(w.sim.calls.length).toBe(callsBefore);
    const after = await w.inbox.getReview(w.ctx, id);
    expect(after.kind === "ok" && [after.review.operation, after.review.bucket]).toEqual(["none", "unreplied"]);
    // 閉じるものが無いときは、何も変えずに知らせる
    expect(await w.inbox.dismissReplyOperation(w.ctx, id)).toMatchObject({ ok: false });
  });
});

describe("連携・店舗の変更や利用不可への変更と、処理が重なったとき(§3-A)", () => {
  it("送る直前の取り直しの間に店舗を選び直すと、送らない", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    w.sim.delayNext("review", 400);
    const pending = w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "古い画面からの返信", expectedReply: null });
    await new Promise((r) => setTimeout(r, 100));
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    const sent = await pending;
    expect(sent.kind).toBe("unavailable");
    expect(w.sim.replyOf(R1)).toBeNull();
  });

  it("送る直前の取り直しの間に利用不可になると、送らない", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    w.sim.delayNext("review", 400);
    const pending = w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "返信", expectedReply: null });
    await new Promise((r) => setTimeout(r, 100));
    await sql`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${w.salon.salonId} and feature_key = 'reviews'`;
    const sent = await pending;
    expect(sent).toMatchObject({ kind: "unavailable" });
    expect(w.sim.replyOf(R1)).toBeNull();
  });

  it("送信の開始後に店舗を選び直すと、結果は記録だけ残り、新しい世代では「送信結果を確認中」で追える", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    w.sim.delayNext("reply", 400);
    const pending = w.inbox.submitReply(w.ctx, { reviewId: id, opId: randomUUID(), action: "upsert", text: "送り始めた返信", expectedReply: null });
    await new Promise((r) => setTimeout(r, 150));
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    const sent = await pending;
    expect(sent.kind).toBe("accepted");
    expect(w.sim.replyOf(R1)?.comment).toBe("送り始めた返信");
    // 古い口コミの ID は使えない(別の世代の画面に表示しない)
    expect((await w.inbox.getReview(w.ctx, id)).kind).toBe("not_found");
    const fresh = (await items(w, "all")).items.find((i) => i.comment.includes("カットの相談"))!;
    expect(fresh.id).not.toBe(id);
    // 新しい世代の取り込みは選び直したときの取得(送信の反映の前)なので、Google で確かめるまで確認が必要
    expect([fresh.operation, fresh.bucket]).toEqual(["sent_checking", "attention"]);
  });

  it("取り込みの途中で口コミの結び付けが外れると、書き込まずにやめる", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    w.sim.delayNext("reviews", 400);
    const pending = w.inbox.refresh(w.ctx);
    await new Promise((r) => setTimeout(r, 100));
    await sql`select * from public.google_unbind_features(${w.salon.salonId}, ${["gbp"]}, ${w.salon.userId}, false)`;
    const r = await pending;
    expect(r.ok).toBe(false);
    const [n] = await sql`select count(*)::int as n from public.gbp_review_index where salon_id = ${w.salon.salonId}`;
    expect(n.n).toBe(0);
  });

  it("AI の入力を読んだあとに店舗が変わったら、まだ同じ世代か(isCurrent)が false になる。古い下書きは保存しない", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const id = await idOf(w, "カットの相談");
    const input = await w.inbox.getReplyInput(w.ctx, id);
    expect(input.ok && [input.value.rating, input.value.text.length > 0]).toEqual([5, true]);
    if (!input.ok) throw new Error();
    expect(await w.inbox.isCurrent(w.ctx, id, input.value.locationId)).toBe(true);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    expect(await w.inbox.isCurrent(w.ctx, id, input.value.locationId)).toBe(false);
    expect((await w.inbox.saveDraft(w.ctx, id, "古い画面の下書き")).ok).toBe(false);
  });
});

describe("403 の分類(§3-B)", () => {
  async function bindingState(w: World) {
    const rows = await sql`
      select b.feature, b.scope_missing_since is not null as missing, a.auth_state
        from public.salon_google_bindings b join public.google_accounts a on a.id = b.google_account_id
       where b.salon_id = ${w.salon.salonId} order by b.feature`;
    return rows.map((r) => [r.feature, r.missing, r.auth_state]);
  }

  it.each([
    ["permission_denied", "この店舗を管理する権限"],
    ["forbidden", "この店舗を管理する権限"],
    ["service_disabled", "現在、Googleの口コミの機能を利用できません"],
  ] as const)("%s は表示だけで、口コミ・Gmail の結び付けとアカウントの状態を変えない", async (kind, message) => {
    await releaseLocations();
    const w = await world({ bindGmail: true });
    await connected(w);
    const before = await bindingState(w);
    w.sim.failNext("reviews", new GbpApiError(kind));
    const r = await w.inbox.refresh(w.ctx);
    expect(r.ok === false && r.error).toContain(message);
    expect(await bindingState(w)).toEqual(before);
    expect((await w.inbox.getConnection(w.ctx)).kind).toBe("connected");
  });

  it("口コミの権限不足と確かめられた 403 だけ、口コミの結び付けに記録する(Gmail・アカウントは変えない)", async () => {
    await releaseLocations();
    const w = await world({ bindGmail: true });
    await connected(w);
    w.sim.failNext("reviews", new GbpApiError("scope_insufficient"));
    const r = await w.inbox.refresh(w.ctx);
    expect(r.ok === false && r.error).toContain("口コミの権限が足りません");
    expect(await bindingState(w)).toEqual([
      ["gbp", true, "active"],
      ["gmail", false, "active"],
    ]);
    expect((await w.inbox.getConnection(w.ctx)).kind).toBe("scope_missing");
    const [{ n }] = await sql`select count(*)::int as n from public.notifications_list_pollable_salons(null) where salon_id = ${w.salon.salonId}`;
    void n; // 予約メールの取得の対象は、予約通知の運用状態で決まる(ここでは Gmail の結び付けが変わらないことを確かめた)
  });
});

describe("画面と DB の分類が一致する", () => {
  it("返信の状態 × Google の返信の有無・審査の状態のすべてで、絞り込みの分類が同じ", async () => {
    const { replyBucket, replyDisplayState } = await import("@/lib/googleReviews/replyState");
    const operations = ["none", "sending", "unknown", "sent_checking", "send_failed", "replace_failed", "delete_failed"] as const;
    const states = [null, "PENDING", "APPROVED", "REJECTED", "UNSPECIFIED"] as const;
    let checked = 0;
    for (const operation of operations) {
      for (const state of states) {
        // DB の gbp_reply_op_display は、返信がある口コミに send_failed を出さない(送れなかった=返信が無いと分かっているとき)。
        if (operation === "send_failed" && state !== null) continue;
        const [row] = await sql`select public.gbp_reply_bucket(${operation}, ${state !== null}, ${state}) as b`;
        const reply = state ? { comment: "返信", updateTime: "2026-10-15T00:00:00Z", state, policyViolation: null } : null;
        expect([operation, state, row.b]).toEqual([operation, state, replyBucket(replyDisplayState({ operation, reply }))]);
        checked++;
      }
    }
    expect(checked).toBe(31);
  });
});

describe("画面を開いたときの取り込み(［更新］と同じ処理。5分の間隔・取得中の重複・一時的な失敗)", () => {
  const lastChecked = async (w: World) => (await items(w, "all")).summary.lastCheckedAt;

  it("5分以内に何度開いても Google を呼ばず、最終更新の時刻も変えない", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const before = await lastChecked(w);
    const callsBefore = w.sim.calls.length;
    const opened = w.make({ minRefreshIntervalMs: GBP_MIN_REFRESH_INTERVAL_MS });
    for (let n = 0; n < 3; n++) {
      const r = await opened.refresh(w.ctx);
      expect(r.ok && Date.parse(r.value.lastCheckedAt)).toBe(Date.parse(before!));
    }
    expect(w.sim.calls.length).toBe(callsBefore);
    expect(await lastChecked(w)).toBe(before);
  });

  it("取り込み済みの新しい口コミは、5分以内で取得を省いたあとの一覧の読み直しにも出る(Google は呼ばない)", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const at = new Date().toISOString();
    w.sim.addReview("locations/sim-101", { name: "accounts/sim-1/locations/sim-101/reviews/sim-auto", starRating: "FIVE", comment: "(架空)開いたときに取り込んだ口コミ", createTime: at, updateTime: at });
    expect((await w.inbox.refresh(w.ctx)).ok).toBe(true); // 画面を開いたときの取り込み(一覧の入れ替えは画面が省いた)
    const callsBefore = w.sim.calls.length;
    const opened = w.make({ minRefreshIntervalMs: GBP_MIN_REFRESH_INTERVAL_MS });
    expect((await opened.refresh(w.ctx)).ok).toBe(true); // 手動の［更新］・開き直し:5分以内なので取得を省く
    expect(w.sim.calls.length).toBe(callsBefore);
    const list = await opened.listReviews(w.ctx, { ...DEFAULT_LIST_QUERY, filter: "all" }, null);
    expect(list.kind === "ok" && list.items.some((i) => i.comment === "(架空)開いたときに取り込んだ口コミ")).toBe(true);
  });

  it("取得中にもう一度呼ばれたら Google を呼ばずに返す(一時的な失敗)", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    w.sim.delayNext("reviews", 400);
    const pending = w.inbox.refresh(w.ctx);
    await new Promise((r) => setTimeout(r, 100));
    const callsDuring = w.sim.calls.length;
    expect(await w.inbox.refresh(w.ctx)).toMatchObject({ ok: false, temporary: true });
    expect(w.sim.calls.length).toBe(callsDuring);
    expect((await pending).ok).toBe(true);
  });

  it.each(["unavailable", "timeout", "network", "rate_limited"] as const)("%s は一時的な失敗。最終更新の時刻を変えない", async (kind) => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const before = await lastChecked(w);
    w.sim.failNext("reviews", new GbpApiError(kind));
    expect(await w.inbox.refresh(w.ctx)).toMatchObject({ ok: false, temporary: true });
    expect(await lastChecked(w)).toBe(before);
  });

  it("再連携が必要(トークンを取り直せない)は、利用者の対応が要る失敗(一時的な失敗にしない)", async () => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    const revoked = w.make({
      access: {
        ...accessFor(sql),
        accessToken: async () => {
          throw new GbpTokenError("invalid_grant");
        },
      },
    });
    const r = await revoked.refresh(w.ctx);
    expect(r.ok === false && r.error).toContain("再連携");
    expect("temporary" in r).toBe(false);
  });

  it.each([
    ["scope_insufficient", "口コミの権限が足りません"],
    ["permission_denied", "この店舗を管理する権限"],
    ["failed_precondition", "オーナー確認"],
  ] as const)("%s は利用者の対応が要る失敗(一時的な失敗にしない)", async (kind, message) => {
    await releaseLocations();
    const w = await world();
    await connected(w);
    w.sim.failNext("reviews", new GbpApiError(kind));
    const r = await w.inbox.refresh(w.ctx);
    expect(r.ok === false && r.error).toContain(message);
    expect("temporary" in r).toBe(false);
  });
});
