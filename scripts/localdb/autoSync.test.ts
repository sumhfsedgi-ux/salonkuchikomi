// 口コミの自動取得(lib/gbp/autoSync.ts)を、ローカルの PostgreSQL の本物の SQL(0027〜0033)・第1段階の同期
// (lib/gbp/inbox.ts)・架空の Google の口コミの API(lib/gbp/simulated.ts)でまとめて確かめる(npm run test:localdb)。値はすべて架空。
//   - 期限の来た店舗だけを取り込み、新しい口コミがイベントになる(初回の分・編集・手動との重なりは増やさない)
//   - 途中で区切った初回の取り込みを、自動で続きから読む
//   - refresh token の失効は自動取得の記録にだけ残し、2回で止まる(アカウントの認証状態・Gmail は変えない)
//   - 利用許可が無い・同意が古い店舗は取得しない
//   - Google の通知を受けた店舗は、手動の更新の直後でも取りに行き、最初から読んだ同期で通知を済みにする
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { createSalon, type SalonFixture } from "./fixtures";
import { createLocalRpcClient } from "./rpcClient";
import { createRpcGbpStore } from "@/lib/gbp/supabaseStore";
import { createGbpInbox, GBP_CONSENT_VERSION, type GbpInbox, type GbpInboxDeps } from "@/lib/gbp/inbox";
import { createSimulatedGbp, simulatedGbpToken, type SimulatedGbp } from "@/lib/gbp/simulated";
import { simulatedGbpUsers, SIM_OWNER_SUB } from "@/lib/gbp/dev/simulatedFixtures";
import { GbpTokenError, type GbpAccess, type GbpBinding } from "@/lib/gbp/access";
import { runAutoSync } from "@/lib/gbp/autoSync";
import { createRpcReviewAlertStore } from "@/lib/reviews/alerts/store";
import { createDeadline } from "@/lib/notifications/jobs/runBudget";

const DB = "salonpack_localdb_auto_sync";
const SECRET = "localdb-test-review-key-secret-0000000000000";
const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";
let sql: Sql;

interface World {
  salon: SalonFixture;
  accountId: string;
  ctx: { salonId: string; userId: string };
  sim: SimulatedGbp;
  inbox: GbpInbox;
  tokenFails: { value: boolean };
  make: (extra: Partial<GbpInboxDeps>) => GbpInbox;
}

function accessFor(db: Sql, tokenFails: { value: boolean }): GbpAccess {
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
      if (tokenFails.value) throw new GbpTokenError("invalid_grant");
      return simulatedGbpToken(binding.googleSub, "local-access-token");
    },
    async markScopeMissing(salonId, scopes) {
      await db`select public.google_mark_binding_scope(${salonId}, 'gbp', true, ${scopes})`;
    },
  };
}

async function world(): Promise<World> {
  await sql`update public.gbp_locations set status = 'disconnected' where status = 'active'`;
  const salon = await createSalon(sql, { plan: "reviews" });
  const accountId = randomUUID();
  await sql`
    insert into public.google_accounts (id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv,
                                        refresh_token_tag, key_version, granted_scopes)
    values (${accountId}, ${`client-${accountId.slice(0, 8)}`}, ${SIM_OWNER_SUB}, 'owner@example.test', 'c', 'i', 't', 'v1',
            ${["openid", "email", GBP_SCOPE]})`;
  await sql`select * from public.google_bind_features(${salon.salonId}, ${accountId}, ${["gbp"]}, null, ${salon.userId}, ${[GBP_SCOPE]})`;
  await sql`update public.feature_catalog set lifecycle = 'available' where feature_key = 'google_reviews'`;
  await sql`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${salon.salonId}, 'reviews', 'allow')`;
  const sim = createSimulatedGbp({ users: simulatedGbpUsers() });
  const tokenFails = { value: false };
  const make = (extra: Partial<GbpInboxDeps>) =>
    createGbpInbox({
      store: createRpcGbpStore(createLocalRpcClient(sql)),
      api: sim.api,
      access: accessFor(sql, tokenFails),
      reviewKeySecret: SECRET,
      canWrite: () => true,
      ...extra,
    });
  return { salon, accountId, ctx: { salonId: salon.salonId, userId: salon.userId }, sim, inbox: make({}), tokenFails, make };
}

const alertStore = () => createRpcReviewAlertStore(createLocalRpcClient(sql));

async function auto(inbox: GbpInbox) {
  return runAutoSync({ store: alertStore(), inbox, consentVersion: GBP_CONSENT_VERSION, deadline: createDeadline(45_000) });
}

async function eventsOf(salonId: string) {
  return sql<{ source: string }[]>`select source from public.review_alert_events where salon_id = ${salonId} order by detected_at`;
}

async function makeDue(salonId: string) {
  await sql`update public.gbp_auto_sync set next_due_at = now() where salon_id = ${salonId}`;
  // 最短の間隔(5分)と、失敗のあとの処理権の待ち(30秒)を過ぎたことにする
  await sql`update public.gbp_locations set last_synced_at = now() - interval '1 hour', sync_lease_until = null
             where salon_id = ${salonId} and status = 'active' and sync_lease_token is null`;
}

function newReview(w: World, location: string, key: string) {
  const at = new Date().toISOString();
  w.sim.addReview(location, {
    name: `accounts/sim-1/${location}/reviews/${key}`,
    starRating: "TWO",
    comment: `(架空)${key}`,
    createTime: at,
    updateTime: at,
  } as never);
}

beforeAll(async () => {
  sql = await createDatabase(DB);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

describe("自動取得", () => {
  it("期限の来た店舗の新しい口コミを取り込み、イベントにする。次の期限までは取りに行かない", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    expect(await w.inbox.selectLocation(w.ctx, "locations/sim-101")).toEqual({ ok: true, value: undefined });
    expect(await eventsOf(w.salon.salonId)).toEqual([]); // 初回の分はイベントにならない

    newReview(w, "locations/sim-101", "auto-1");
    await makeDue(w.salon.salonId);
    const first = await auto(w.inbox);
    expect(first).toMatchObject({ attempted: 1, complete: 1, failed: 0 });
    expect(await eventsOf(w.salon.salonId)).toEqual([{ source: "reconcile" }]);

    const callsBefore = w.sim.calls.length;
    const second = await auto(w.inbox);
    expect(second.attempted).toBe(0);
    expect(w.sim.calls.length).toBe(callsBefore);
  });

  it("手動の更新と自動取得が同じ口コミを取り込んでもイベントは1件。投稿者の編集はイベントにならない", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    newReview(w, "locations/sim-101", "both-1");
    const manual = w.make({ minRefreshIntervalMs: 0 });
    expect((await manual.refresh(w.ctx)).ok).toBe(true);
    w.sim.editReview("accounts/sim-1/locations/sim-101/reviews/both-1", "(架空)編集しました");
    await makeDue(w.salon.salonId);
    expect((await auto(w.inbox)).complete).toBe(1);
    expect(await eventsOf(w.salon.salonId)).toEqual([{ source: "manual" }]);
  });

  it("途中で区切った初回の取り込みを自動で続け、終わるまでの口コミはイベントにしない", async () => {
    const w = await world();
    const small = w.make({ maxSyncPages: 1 });
    await small.recordConsent(w.ctx);
    // 60件を足して64件にする(1ページは50件)。1ページで区切る
    for (let i = 0; i < 60; i++) {
      const at = new Date(Date.now() - (i + 10) * 60_000).toISOString();
      w.sim.addReview("locations/sim-101", { name: `accounts/sim-1/locations/sim-101/reviews/many-${i}`, starRating: "FOUR", comment: `(架空)${i}`, createTime: at, updateTime: at } as never);
    }
    expect(await small.selectLocation(w.ctx, "locations/sim-101")).toEqual({ ok: true, value: undefined });
    const [before] = await sql<{ done: Date | null }[]>`
      select initial_sync_done_at as done from public.gbp_locations where salon_id = ${w.salon.salonId} and status = 'active'`;
    expect(before.done).toBeNull();
    let guard = 0;
    for (;;) {
      const s = await runAutoSync({ store: alertStore(), inbox: small, consentVersion: GBP_CONSENT_VERSION, deadline: createDeadline(45_000) });
      if (s.complete === 1) break;
      expect(s.partial).toBe(1);
      expect(++guard).toBeLessThan(5);
    }
    const [after] = await sql<{ done: Date | null }[]>`
      select initial_sync_done_at as done from public.gbp_locations where salon_id = ${w.salon.salonId} and status = 'active'`;
    expect(after.done).not.toBeNull();
    expect(await eventsOf(w.salon.salonId)).toEqual([]);
  });

  it("refresh token の失効は自動取得の記録にだけ残し、同じ世代で2回続いたら止まる(アカウントの状態は変えない)", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    w.tokenFails.value = true;
    await makeDue(w.salon.salonId);
    expect(await auto(w.inbox)).toMatchObject({ attempted: 1, failed: 1, authHolds: 0 });
    await makeDue(w.salon.salonId);
    expect(await auto(w.inbox)).toMatchObject({ attempted: 1, failed: 1, authHolds: 1 });
    await makeDue(w.salon.salonId);
    expect((await auto(w.inbox)).attempted).toBe(0);
    const [acc] = await sql<{ auth_state: string; consecutive_auth_failures: number }[]>`
      select auth_state, consecutive_auth_failures from public.google_accounts where id = ${w.accountId}`;
    expect(acc).toEqual({ auth_state: "active", consecutive_auth_failures: 0 });
    // 再連携(トークンの世代が進む)で、また取りに行く
    w.tokenFails.value = false;
    await sql`update public.google_accounts set token_generation = token_generation + 1 where id = ${w.accountId}`;
    expect((await auto(w.inbox)).complete).toBe(1);
  });

  it("利用許可が無い店舗・同意が古い店舗は取りに行かない", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    await makeDue(w.salon.salonId);
    const old = await runAutoSync({ store: alertStore(), inbox: w.inbox, consentVersion: "gbp-connect-newer", deadline: createDeadline(45_000) });
    expect(old.attempted).toBe(0);
    await sql`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${w.salon.salonId} and feature_key = 'reviews'`;
    expect((await auto(w.inbox)).attempted).toBe(0);
  });

  it("Google の通知を受けた店舗は、手動の更新の直後でも取りに行き、最初から読んだ同期で通知を済みにする", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    // 手動の更新の直後(5分の間隔の内側)
    await sql`update public.gbp_locations set last_synced_at = now() where salon_id = ${w.salon.salonId} and status = 'active'`;
    newReview(w, "locations/sim-101", "push-1");
    await sql`insert into public.gbp_auto_sync (location_id, salon_id, next_due_at, requested_at)
              select id, salon_id, now(), now() - interval '1 second' from public.gbp_locations
               where salon_id = ${w.salon.salonId} and status = 'active'
              on conflict (location_id) do update set next_due_at = now(), requested_at = now() - interval '1 second'`;
    expect((await auto(w.inbox)).complete).toBe(1);
    expect(await eventsOf(w.salon.salonId)).toEqual([{ source: "pubsub" }]);
    const [row] = await sql<{ requested_at: Date | null }[]>`select requested_at from public.gbp_auto_sync where salon_id = ${w.salon.salonId}`;
    expect(row.requested_at).toBeNull();
  });
});

describe("Google の通知(0034)", () => {
  const record = async (messageId: string, locationName: string | null) =>
    (await alertStore().recordPush({ messageId, notificationType: "NEW_REVIEW", locationName, publishTime: new Date().toISOString() }));
  const message = async (messageId: string) => {
    const [m] = await sql<{ status: string }[]>`select status from public.gbp_push_messages where message_id = ${messageId}`;
    return m?.status ?? null;
  };

  it("受信の直後に止まっても(前倒しの処理が動かなくても)、次の定期処理が取り込み、受信を済みにする", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    await sql`update public.gbp_locations set last_synced_at = now() where salon_id = ${w.salon.salonId} and status = 'active'`;
    await sql`update public.gbp_auto_sync set next_due_at = now() + interval '1 hour' where salon_id = ${w.salon.salonId}`;
    newReview(w, "locations/sim-101", "push-late");
    const id = `msg-${randomUUID()}`;
    expect(await record(id, "locations/sim-101")).toBe("recorded");
    expect(await message(id)).toBe("received");
    // ここで処理が止まった(after() は動かなかった)。次の定期処理:
    expect((await auto(w.inbox)).complete).toBe(1);
    expect(await eventsOf(w.salon.salonId)).toEqual([{ source: "pubsub" }]);
    expect(await message(id)).toBe("done");
    // 済んだあとの再送は記録だけ
    expect(await record(id, "locations/sim-101")).toBe("duplicate_done");
  });

  it("済んでいない受信の再送は、取り込み待ちを立て直す。どの店舗にも当たらない通知は記録だけ", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    const id = `msg-${randomUUID()}`;
    expect(await record(id, "locations/sim-101")).toBe("recorded");
    await sql`update public.gbp_auto_sync set requested_at = null, next_due_at = now() + interval '1 hour' where salon_id = ${w.salon.salonId}`;
    expect(await record(id, "locations/sim-101")).toBe("duplicate_pending");
    const [s] = await sql<{ requested: boolean; due: boolean }[]>`
      select requested_at is not null as requested, next_due_at <= now() as due from public.gbp_auto_sync where salon_id = ${w.salon.salonId}`;
    expect(s).toEqual({ requested: true, due: true });
    expect(await record(`msg-${randomUUID()}`, "locations/not-linked")).toBe("ignored");
    expect(await record(`msg-${randomUUID()}`, null)).toBe("ignored");
  });

  it("LINE 通知中の店舗の GBP アカウントだけ登録の対象。止めたら解除の対象(登録したものだけ)", async () => {
    const w = await world();
    await w.inbox.recordConsent(w.ctx);
    await w.inbox.selectLocation(w.ctx, "locations/sim-101");
    const store = alertStore();
    const work = async () => (await store.registrationWork()).filter((x) => x.salonId === w.salon.salonId);
    expect(await work()).toEqual([]);
    const [lc] = await sql<{ id: string }[]>`
      insert into public.line_connections (salon_id, destination_id, status, label, recipient_since)
      values (${w.salon.salonId}, ${`U${randomUUID().replace(/-/g, "")}`}, 'connected', 'オーナー', now()) returning id`;
    await sql`select public.review_alert_set_recipient(${w.salon.salonId}, ${lc.id}, true, ${w.salon.userId})`;
    const [{ version }] = await sql<{ version: number }[]>`select coalesce((select version from public.review_alert_settings where salon_id = ${w.salon.salonId}), 0) as version`;
    const [start] = await sql<{ r: string }[]>`select public.review_alert_start(${w.salon.salonId}, ${w.salon.userId}, ${version}, ${GBP_CONSENT_VERSION}) as r`;
    expect(start.r).toBe("started");
    expect(await work()).toEqual([{ action: "register", accountName: "accounts/sim-1", googleAccountId: w.accountId, salonId: w.salon.salonId }]);
    await store.setRegistration("accounts/sim-1", "ours", w.accountId);
    expect(await work()).toEqual([]);
    expect((await store.pushActiveAccounts()).has(w.accountId)).toBe(true);
    await sql`select * from public.review_alert_stop(${w.salon.salonId}, ${w.salon.userId})`;
    expect(await work()).toEqual([{ action: "unregister", accountName: "accounts/sim-1", googleAccountId: w.accountId, salonId: w.salon.salonId }]);
    await store.setRegistration("accounts/sim-1", "none", w.accountId);
  });

  it("7日を過ぎた受信の記録は消す", async () => {
    const id = `msg-${randomUUID()}`;
    await record(id, null);
    await sql`update public.gbp_push_messages set received_at = now() - interval '8 days' where message_id = ${id}`;
    expect(await alertStore().purgePush()).toBeGreaterThanOrEqual(1);
    expect(await message(id)).toBeNull();
  });
});
