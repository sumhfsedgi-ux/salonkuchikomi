// 届いた口コミの DB(0027〜0030)をローカルの PostgreSQL で確かめる(npm run test:localdb)。値はすべて架空。
//   - 選択の世代:選び直し・アカウントの切り替え・口コミの結び付けの解除で、古い世代が使えなくなり、内容が消える
//   - 古い処理(同期・取り込み・下書き・送信)が、変更後に書き戻さない(同時の接続での待ち合わせも)
//   - 新着の数え方(初回の分・編集・期限切れのあとの取り直し・初回の途中)
//   - 期限の削除は、利用可否(準備中・許可なし)に関係なく動く
//   - 返信の操作:利用可否・世代の確認、未返信と確認が必要の分類、世代をまたいだ結果不明の追跡、1分の回数
//   - 権限:関数は service role だけ
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { createSalon, type SalonFixture } from "./fixtures";

const DB = "salonpack_localdb_reviews";
let sql: Sql;

const TTL = 25 * 24 * 3600;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function createAccount(db: Sql, sub = `sub-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await db`
    insert into public.google_accounts (id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv,
                                        refresh_token_tag, key_version, granted_scopes)
    values (${id}, 'test-client', ${sub}, ${`${sub}@example.test`}, 'c', 'i', 't', 'v1',
            ${["openid", "email", "https://www.googleapis.com/auth/business.manage"]})`;
  return id;
}

async function bindGbp(db: Sql, salon: SalonFixture, accountId: string): Promise<string> {
  const [row] = await db<{ event: string }[]>`
    select * from public.google_bind_features(${salon.salonId}, ${accountId}, ${["gbp"]}, null, ${salon.userId},
                                              ${["https://www.googleapis.com/auth/business.manage"]})`;
  return row.event;
}

async function selectLocation(db: Sql, salon: SalonFixture, accountId: string, location = "locations/100"): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    select public.gbp_select_location(${salon.salonId}, ${accountId}, 'accounts/1', ${location}, '架空の店', '架空の住所',
                                      ${salon.userId}) as id`;
  return row.id;
}

async function usable(db: Sql, salonId: string, locationId: string): Promise<boolean> {
  const [row] = await db<{ ok: boolean }[]>`select public.gbp_location_usable(${salonId}, ${locationId}) as ok`;
  return row.ok;
}

function review(key: string, opts: { reply?: string | null; state?: string | null; comment?: string } = {}) {
  const now = new Date().toISOString();
  return {
    review_key: key.padEnd(40, "0"),
    review_name: `accounts/1/locations/100/reviews/${key}`,
    reviewer_name: "架空の投稿者",
    reviewer_photo_url: null,
    is_anonymous: false,
    star_rating: 5,
    comment: opts.comment ?? "(架空の口コミ)",
    create_time: now,
    update_time: now,
    reply_comment: opts.reply ?? null,
    reply_update_time: opts.reply ? now : null,
    reply_state: opts.state ?? (opts.reply ? "PENDING" : null),
    policy_violation: null,
    media: [],
    reply_url: null,
  };
}

async function ingest(db: Sql, salonId: string, locationId: string, reviews: unknown[], lease: string | null = null) {
  return db<{ review_index_id: string; created: boolean }[]>`
    select * from public.gbp_ingest_reviews(${salonId}, ${locationId}, ${lease}, 'manual', ${db.json(reviews as never)}, ${TTL})`;
}

async function beginSync(db: Sql, salonId: string, locationId: string) {
  const [row] = await db<{ outcome: string; lease_token: string; run_kind: string }[]>`
    select * from public.gbp_begin_sync(${salonId}, ${locationId}, 60, 1728000, 0, 3600)`;
  return row;
}

async function finishSync(db: Sql, salonId: string, locationId: string, lease: string) {
  const [row] = await db<{ at: Date | null }[]>`
    select public.gbp_finish_sync(${salonId}, ${locationId}, ${lease}, now(), 4.5, 12) as at`;
  return row.at;
}

async function summary(db: Sql, salonId: string) {
  const [row] = await db`select * from public.gbp_inbox_summary(${salonId})`;
  return row;
}

async function allowGoogleReviews(db: Sql, salonId: string) {
  await db`update public.feature_catalog set lifecycle = 'available' where feature_key = 'google_reviews'`;
  await db`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${salonId}, 'google_reviews', 'allow')
           on conflict (salon_id, feature_key) do update set mode = 'allow'`;
}

async function begin(db: Sql, salon: SalonFixture, reviewIndexId: string, opts: { text?: string | null; action?: "upsert" | "delete"; base?: string | null; opId?: string; rate?: number } = {}) {
  const action = opts.action ?? "upsert";
  const text = action === "upsert" ? (opts.text ?? "ありがとうございます") : null;
  const [row] = await db<{ outcome: string; operation_id: string; lease_token: string }[]>`
    select * from public.gbp_begin_reply_operation(${opts.opId ?? randomUUID()}, ${salon.salonId}, ${reviewIndexId}, ${action},
      ${text ? sha(text) : null}, ${text ? Buffer.byteLength(text) : null}, ${opts.base ?? null}, ${salon.userId}, 60, ${opts.rate ?? 10})`;
  return row;
}

async function startSend(db: Sql, salonId: string, opId: string, lease: string) {
  const [row] = await db<{ r: string }[]>`select public.gbp_reply_start_send(${salonId}, ${opId}, ${lease}, 30, '[]'::jsonb, ${TTL}) as r`;
  return row.r;
}

async function finish(db: Sql, salonId: string, opId: string, lease: string, status: string, reviews: unknown[] = []) {
  const [row] = await db<{ ok: boolean }[]>`
    select public.gbp_finish_reply_operation(${salonId}, ${opId}, ${lease}, ${status}, null, ${db.json(reviews as never)}, ${TTL}, null) as ok`;
  return row.ok;
}

async function detail(db: Sql, salonId: string, reviewIndexId: string) {
  const [row] = await db`select * from public.gbp_get_review(${salonId}, ${reviewIndexId})`;
  return row;
}

async function list(db: Sql, salonId: string, filter: string) {
  return db<{ review_index_id: string; operation: string; bucket: string; is_new: boolean }[]>`
    select * from public.gbp_list_reviews(${salonId}, ${filter}, 'all', 'newest', 0, 50)`;
}

/** 店舗・アカウント・結び付け・選択までを作る(初回の取り込みは済ませない)。 */
async function connectedSalon(db: Sql, plan: "reviews" | "salonpack" = "reviews") {
  const salon = await createSalon(db, { plan });
  const accountId = await createAccount(db);
  await bindGbp(db, salon, accountId);
  const locationId = await selectLocation(db, salon, accountId, `locations/${randomUUID().slice(0, 8)}`);
  return { salon, accountId, locationId };
}

/** 初回の取り込みを済ませた状態(p 件の過去の口コミ)。 */
async function syncedSalon(db: Sql, keys: string[] = ["past-a", "past-b"]) {
  const c = await connectedSalon(db);
  const s = await beginSync(db, c.salon.salonId, c.locationId);
  const rows = await ingest(db, c.salon.salonId, c.locationId, keys.map((k) => review(k)), s.lease_token);
  await finishSync(db, c.salon.salonId, c.locationId, s.lease_token);
  return { ...c, rows };
}

beforeAll(async () => {
  sql = await createDatabase(DB);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

describe("権限", () => {
  it("口コミの関数は anon・authenticated から実行できず、表も読めない", async () => {
    const fns = await sql<{ proname: string; anon: boolean; auth: boolean; svc: boolean }[]>`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as auth,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'gbp\\_%'`;
    expect(fns.length).toBeGreaterThan(20);
    for (const f of fns) expect([f.proname, f.anon, f.auth, f.svc]).toEqual([f.proname, false, false, true]);
    for (const table of ["gbp_locations", "gbp_review_index", "gbp_review_cache", "gbp_reply_drafts", "gbp_reply_operations", "gbp_consents", "review_reply_settings"]) {
      const [row] = await sql<{ anon: boolean; auth: boolean; rls: boolean }[]>`
        select has_table_privilege('anon', ${"public." + table}, 'select') as anon,
               has_table_privilege('authenticated', ${"public." + table}, 'select') as auth,
               (select relrowsecurity from pg_class where oid = ${"public." + table}::regclass) as rls`;
      expect([table, row]).toEqual([table, { anon: false, auth: false, rls: true }]);
    }
  });

  it("0030 の直後は、どの店舗も届いた口コミを使えない(準備中・標準は使えない)", async () => {
    const s = await createSalon(sql, { plan: "salonpack" });
    const [row] = await sql`select * from public.salon_feature_access(${s.salonId}, 'google_reviews')`;
    expect(row).toEqual({ allowed: false, reason: "lifecycle_coming_soon" });
  });
});

describe("選択の世代(§3-A)", () => {
  it("選んだ世代だけが使える。選び直すと新しい行になり、前の世代の内容・索引は消える", async () => {
    const c = await connectedSalon(sql);
    expect(await usable(sql, c.salon.salonId, c.locationId)).toBe(true);
    const [b] = await sql`select gbp_selection_state from public.salon_google_bindings where salon_id = ${c.salon.salonId} and feature = 'gbp'`;
    expect(b.gbp_selection_state).toBe("selected");
    const rows = await ingest(sql, c.salon.salonId, c.locationId, [review("k1")]);
    await sql`select public.gbp_save_draft(${c.salon.salonId}, ${rows[0].review_index_id}, '下書き', ${TTL})`;

    const [{ location_name }] = await sql`select location_name from public.gbp_locations where id = ${c.locationId}`;
    const again = await selectLocation(sql, c.salon, c.accountId, location_name);
    expect(again).not.toBe(c.locationId);
    expect(await usable(sql, c.salon.salonId, c.locationId)).toBe(false);
    expect(await usable(sql, c.salon.salonId, again)).toBe(true);
    const counts = await sql`
      select (select count(*)::int from public.gbp_review_index where location_id = ${c.locationId}) as idx,
             (select count(*)::int from public.gbp_review_cache where salon_id = ${c.salon.salonId}) as cache,
             (select count(*)::int from public.gbp_reply_drafts where salon_id = ${c.salon.salonId}) as drafts`;
    expect(counts[0]).toEqual({ idx: 0, cache: 0, drafts: 0 });
  });

  it("アカウントの切り替え・口コミの結び付けの解除で、その店舗の世代は使えなくなり内容が消える。同じアカウントでの再連携はそのまま", async () => {
    const c = await connectedSalon(sql);
    await ingest(sql, c.salon.salonId, c.locationId, [review("k1")]);
    // 同じアカウントでの再連携(権限の追加・再認証)は変えない
    expect(await bindGbp(sql, c.salon, c.accountId)).toBe("reconnected");
    expect(await usable(sql, c.salon.salonId, c.locationId)).toBe(true);
    // 別のアカウントに切り替え
    const other = await createAccount(sql);
    expect(await bindGbp(sql, c.salon, other)).toBe("account_switched");
    expect(await usable(sql, c.salon.salonId, c.locationId)).toBe(false);
    const [l] = await sql`select status from public.gbp_locations where id = ${c.locationId}`;
    expect(l.status).toBe("disconnected");
    expect((await sql`select 1 from public.gbp_review_cache where salon_id = ${c.salon.salonId}`).length).toBe(0);

    // 解除
    const d = await connectedSalon(sql);
    await sql`select * from public.google_unbind_features(${d.salon.salonId}, ${["gbp"]}, ${d.salon.userId}, false)`;
    expect(await usable(sql, d.salon.salonId, d.locationId)).toBe(false);
    await expect(ingest(sql, d.salon.salonId, d.locationId, [review("late")])).rejects.toThrow(/gbp:location_inactive/);
  });

  it("店舗の変更(選び直しの開始)で選択待ちに戻り、今の世代の内容・下書き・索引が消える。違うアカウントを指す要求は何もしない", async () => {
    const c = await connectedSalon(sql, "salonpack");
    await sql`select * from public.google_bind_features(${c.salon.salonId}, ${c.accountId}, ${["gmail"]}, null, ${c.salon.userId}, ${["https://www.googleapis.com/auth/gmail.readonly"]})`;
    const rows = await ingest(sql, c.salon.salonId, c.locationId, [review("k1")]);
    await sql`select public.gbp_save_draft(${c.salon.salonId}, ${rows[0].review_index_id}, '下書き', ${TTL})`;

    const other = await createAccount(sql);
    const [miss] = await sql`select public.gbp_begin_location_change(${c.salon.salonId}, ${other}) as ok`;
    expect(miss.ok).toBe(false);
    expect(await usable(sql, c.salon.salonId, c.locationId)).toBe(true);

    const [hit] = await sql`select public.gbp_begin_location_change(${c.salon.salonId}, ${c.accountId}) as ok`;
    expect(hit.ok).toBe(true);
    expect(await usable(sql, c.salon.salonId, c.locationId)).toBe(false);
    const bindings = await sql`select feature, google_account_id, gbp_selection_state from public.salon_google_bindings where salon_id = ${c.salon.salonId} order by feature`;
    expect(bindings).toEqual([
      { feature: "gbp", google_account_id: c.accountId, gbp_selection_state: "selection_pending" },
      { feature: "gmail", google_account_id: c.accountId, gbp_selection_state: null },
    ]);
    const counts = await sql`
      select (select count(*)::int from public.gbp_review_index where salon_id = ${c.salon.salonId}) as idx,
             (select count(*)::int from public.gbp_review_cache where salon_id = ${c.salon.salonId}) as cache,
             (select count(*)::int from public.gbp_reply_drafts where salon_id = ${c.salon.salonId}) as drafts`;
    expect(counts[0]).toEqual({ idx: 0, cache: 0, drafts: 0 });
    await expect(ingest(sql, c.salon.salonId, c.locationId, [review("late")])).rejects.toThrow(/gbp:location_inactive/);
    const [fn] = await sql`select has_function_privilege('authenticated', 'public.gbp_begin_location_change(uuid, uuid)', 'execute') as can`;
    expect(fn.can).toBe(false);
  });

  it("口コミの結び付けを変えても、同じ店舗の予約メール(Gmail)の結び付けは変わらない", async () => {
    const c = await connectedSalon(sql, "salonpack");
    await sql`select * from public.google_bind_features(${c.salon.salonId}, ${c.accountId}, ${["gmail"]}, null, ${c.salon.userId}, ${["https://www.googleapis.com/auth/gmail.readonly"]})`;
    await sql`select * from public.google_unbind_features(${c.salon.salonId}, ${["gbp"]}, ${c.salon.userId}, false)`;
    const rows = await sql`select feature, google_account_id from public.salon_google_bindings where salon_id = ${c.salon.salonId}`;
    expect(rows).toEqual([{ feature: "gmail", google_account_id: c.accountId }]);
    const [a] = await sql`select auth_state from public.google_accounts where id = ${c.accountId}`;
    expect(a.auth_state).toBe("active");
  });

  it("同期の処理権を失った古い同期は書き込めない", async () => {
    const c = await connectedSalon(sql);
    const s = await beginSync(sql, c.salon.salonId, c.locationId);
    await expect(ingest(sql, c.salon.salonId, c.locationId, [review("k1")], randomUUID())).rejects.toThrow(/gbp:sync_lease_lost/);
    expect((await ingest(sql, c.salon.salonId, c.locationId, [review("k1")], s.lease_token)).length).toBe(1);
  });

  it("取り込みの途中に解除が来ると、解除は取り込みの確定を待ち、確定した分も消す(書き戻らない)", async () => {
    const c = await connectedSalon(sql);
    const c1 = await sql.reserve();
    const c2 = await sql.reserve();
    try {
      await c1`begin`;
      await c1`select * from public.gbp_ingest_reviews(${c.salon.salonId}, ${c.locationId}, null, 'manual', ${c1.json([review("race")] as never)}, ${TTL})`;
      const unbind = (async () => {
        const t0 = Date.now();
        await c2`select * from public.google_unbind_features(${c.salon.salonId}, ${["gbp"]}, ${c.salon.userId}, false)`;
        return Date.now() - t0;
      })();
      await new Promise((r) => setTimeout(r, 400));
      await c1`commit`;
      expect(await unbind).toBeGreaterThan(300);
    } finally {
      c1.release();
      c2.release();
    }
    const left = await sql`select count(*)::int as n from public.gbp_review_index where salon_id = ${c.salon.salonId}`;
    expect(left[0].n).toBe(0);
  });

  it("使えない世代の口コミの下書き・既読は保存しない", async () => {
    const c = await connectedSalon(sql);
    const rows = await ingest(sql, c.salon.salonId, c.locationId, [review("k1")]);
    const [{ location_name }] = await sql`select location_name from public.gbp_locations where id = ${c.locationId}`;
    await selectLocation(sql, c.salon, c.accountId, location_name);
    const [d] = await sql`select public.gbp_save_draft(${c.salon.salonId}, ${rows[0].review_index_id}, '古い画面の下書き', ${TTL}) as at`;
    expect(d.at).toBeNull();
    const [s] = await sql`select public.gbp_set_seen(${c.salon.salonId}, ${rows[0].review_index_id}, true) as ok`;
    expect(s.ok).toBe(false);
  });

  it("ほかの店舗が有効に使っているロケーションは選べない", async () => {
    const c = await connectedSalon(sql);
    const [{ location_name }] = await sql`select location_name from public.gbp_locations where id = ${c.locationId}`;
    const other = await createSalon(sql, { plan: "reviews" });
    const account = await createAccount(sql);
    await bindGbp(sql, other, account);
    await expect(selectLocation(sql, other, account, location_name)).rejects.toThrow(/gbp:linked_elsewhere/);
  });
});

describe("新着(§2)", () => {
  it("初回の取り込みの分は新着にしない。初回の途中は数えない。そのあと初めて見つけた口コミだけ数え、開いたら外れる", async () => {
    const c = await connectedSalon(sql);
    const s = await beginSync(sql, c.salon.salonId, c.locationId);
    await ingest(sql, c.salon.salonId, c.locationId, [review("past-1")], s.lease_token);
    expect((await summary(sql, c.salon.salonId)).new_count).toBeNull(); // 初回の途中
    expect((await summary(sql, c.salon.salonId)).sync_in_progress).toBe(true);
    await ingest(sql, c.salon.salonId, c.locationId, [review("past-2")], s.lease_token); // 初回の続き
    await finishSync(sql, c.salon.salonId, c.locationId, s.lease_token);
    let sum = await summary(sql, c.salon.salonId);
    expect([sum.initial_sync_done, sum.new_count, Number(sum.average_rating), sum.total_review_count]).toEqual([true, 0, 4.5, 12]);

    await new Promise((r) => setTimeout(r, 20));
    const fresh = await ingest(sql, c.salon.salonId, c.locationId, [review("fresh-1")]);
    // 既存の口コミの編集(同じキーの取り直し)は新着にしない
    await ingest(sql, c.salon.salonId, c.locationId, [review("past-1", { comment: "編集された" })]);
    sum = await summary(sql, c.salon.salonId);
    expect(sum.new_count).toBe(1);
    expect((await list(sql, c.salon.salonId, "new")).map((r) => r.review_index_id)).toEqual([fresh[0].review_index_id]);

    // 期限が切れて内容が消えたあとの取り直しも、新着にしない(見つけた記録で判定)
    await sql`update public.gbp_review_cache set expires_at = now() - interval '1 second'
               where review_index_id in (select id from public.gbp_review_index where location_id = ${c.locationId})`;
    await sql`select public.gbp_purge_expired_content()`;
    await ingest(sql, c.salon.salonId, c.locationId, [review("past-2"), review("fresh-1")]);
    expect((await summary(sql, c.salon.salonId)).new_count).toBe(1);

    await sql`select public.gbp_set_seen(${c.salon.salonId}, ${fresh[0].review_index_id}, true)`;
    expect((await summary(sql, c.salon.salonId)).new_count).toBe(0);
  });

  it("★の平均と件数は Google の値。取ってから25日を過ぎたら出さない(0 にしない)", async () => {
    const c = await syncedSalon(sql);
    await sql`update public.gbp_locations set rating_cached_at = now() - interval '26 days' where id = ${c.locationId}`;
    const sum = await summary(sql, c.salon.salonId);
    expect([sum.average_rating, sum.total_review_count]).toEqual([null, null]);
  });
});

describe("期限の削除(§3-9)", () => {
  it("利用可否(準備中・許可なし)に関係なく、期限切れの内容・下書き・25日を過ぎた店舗の情報を消す", async () => {
    const c = await syncedSalon(sql);
    const [access] = await sql`select * from public.salon_feature_access(${c.salon.salonId}, 'google_reviews')`;
    expect(access.allowed).toBe(false);
    await sql`select public.gbp_save_draft(${c.salon.salonId}, ${c.rows[0].review_index_id}, '下書き', ${TTL})`;
    await sql`update public.gbp_review_cache set expires_at = now() - interval '1 second' where salon_id = ${c.salon.salonId}`;
    await sql`update public.gbp_reply_drafts set expires_at = now() - interval '1 second' where salon_id = ${c.salon.salonId}`;
    await sql`update public.gbp_locations set content_cached_at = now() - interval '26 days', rating_cached_at = now() - interval '26 days' where id = ${c.locationId}`;
    const [r] = await sql`select public.gbp_purge_expired_content() as r`;
    expect(r.r.cache).toBeGreaterThanOrEqual(2);
    const left = await sql`
      select (select count(*)::int from public.gbp_review_cache where salon_id = ${c.salon.salonId}) as cache,
             (select count(*)::int from public.gbp_reply_drafts where salon_id = ${c.salon.salonId}) as drafts,
             (select title_cache from public.gbp_locations where id = ${c.locationId}) as title,
             (select average_rating from public.gbp_locations where id = ${c.locationId}) as rating`;
    expect(left[0]).toEqual({ cache: 0, drafts: 0, title: null, rating: null });
  });

  it("結び付けが替わったのに残っている世代(トリガーの外で変えられた場合)も、削除のときに無効にして消す", async () => {
    const c = await syncedSalon(sql);
    await sql`alter table public.salon_google_bindings disable trigger gbp_binding_changed`;
    try {
      const other = await createAccount(sql);
      await sql`update public.salon_google_bindings set google_account_id = ${other} where salon_id = ${c.salon.salonId} and feature = 'gbp'`;
    } finally {
      await sql`alter table public.salon_google_bindings enable trigger gbp_binding_changed`;
    }
    expect(await usable(sql, c.salon.salonId, c.locationId)).toBe(false);
    const [r] = await sql`select public.gbp_purge_expired_content() as r`;
    expect(r.r.unusable_locations).toBe(1);
    expect((await sql`select 1 from public.gbp_review_cache where salon_id = ${c.salon.salonId}`).length).toBe(0);
  });
});

describe("返信の操作(§2・§3-A)", () => {
  it("届いた口コミを使えない店舗は、操作を始めない(何も記録しない)", async () => {
    await sql`update public.feature_catalog set lifecycle = 'coming_soon' where feature_key = 'google_reviews'`;
    const c = await syncedSalon(sql);
    const r = await begin(sql, c.salon, c.rows[0].review_index_id);
    expect(r.outcome).toBe("not_entitled");
    expect((await sql`select 1 from public.gbp_reply_operations where salon_id = ${c.salon.salonId}`).length).toBe(0);
  });

  it("受け付け → 確認中 → 取り直して一致 → 返信済み。未返信は返信が無いと確かめたものだけ", async () => {
    const c = await syncedSalon(sql);
    await allowGoogleReviews(sql, c.salon.salonId);
    const id = c.rows[0].review_index_id;
    expect((await detail(sql, c.salon.salonId, id)).bucket).toBe("unreplied");
    const r = await begin(sql, c.salon, id, { text: "ありがとうございます" });
    expect(r.outcome).toBe("new");
    expect((await detail(sql, c.salon.salonId, id)).operation).toBe("sending");
    expect((await detail(sql, c.salon.salonId, id)).bucket).toBe("attention");
    expect(await startSend(sql, c.salon.salonId, r.operation_id, r.lease_token)).toBe("ok");
    expect(await finish(sql, c.salon.salonId, r.operation_id, r.lease_token, "accepted", [review("past-a", { reply: "ありがとうございます" })])).toBe(true);
    let d = await detail(sql, c.salon.salonId, id);
    expect([d.operation, d.bucket]).toEqual(["sent_checking", "attention"]);
    await sql`select public.gbp_reconcile_reply_operations(${c.salon.salonId}, ${id}, ${sha("ありがとうございます")}, 'PENDING', now())`;
    d = await detail(sql, c.salon.salonId, id);
    expect([d.operation, d.bucket]).toEqual(["none", "replied"]);
    expect((await list(sql, c.salon.salonId, "unreplied")).map((x) => x.review_index_id)).not.toContain(id);
  });

  it("結果不明は「確認が必要」で、未返信に入れない。取り直して返信が無いと分かってから未返信に戻る", async () => {
    const c = await syncedSalon(sql);
    await allowGoogleReviews(sql, c.salon.salonId);
    const id = c.rows[0].review_index_id;
    const r = await begin(sql, c.salon, id);
    expect(await startSend(sql, c.salon.salonId, r.operation_id, r.lease_token)).toBe("ok");
    expect(await finish(sql, c.salon.salonId, r.operation_id, r.lease_token, "unknown")).toBe(true);
    let d = await detail(sql, c.salon.salonId, id);
    expect([d.operation, d.bucket]).toEqual(["unknown", "attention"]);
    expect((await list(sql, c.salon.salonId, "unreplied")).map((x) => x.review_index_id)).not.toContain(id);
    expect((await list(sql, c.salon.salonId, "attention")).map((x) => x.review_index_id)).toContain(id);
    // 取り直しても一致しない(返信が無い)間は、結果不明のまま(推測で未返信にしない)
    await sql`select public.gbp_reconcile_reply_operations(${c.salon.salonId}, ${id}, null, null, null)`;
    expect((await detail(sql, c.salon.salonId, id)).operation).toBe("unknown");
    // 利用者が「送るのをやめる」を選んだら、未返信に戻る
    await sql`select public.gbp_dismiss_reply_operation(${c.salon.salonId}, ${id})`;
    d = await detail(sql, c.salon.salonId, id);
    expect([d.operation, d.bucket]).toEqual(["none", "unreplied"]);
  });

  it("置き換え・削除の失敗で以前の返信が残っているときは「確認が必要」。新規の送信の失敗は未返信", async () => {
    const c = await syncedSalon(sql, ["has-reply", "no-reply", "del-reply"]);
    await allowGoogleReviews(sql, c.salon.salonId);
    await ingest(sql, c.salon.salonId, c.locationId, [review("has-reply", { reply: "以前の返信" }), review("del-reply", { reply: "以前の返信" })]);
    const [replaceId, newId, delId] = c.rows.map((r) => r.review_index_id);

    const a = await begin(sql, c.salon, replaceId, { text: "新しい返信", base: sha("以前の返信") });
    await finish(sql, c.salon.salonId, a.operation_id, a.lease_token, "failed");
    expect([(await detail(sql, c.salon.salonId, replaceId)).operation, (await detail(sql, c.salon.salonId, replaceId)).bucket]).toEqual(["replace_failed", "attention"]);

    const b = await begin(sql, c.salon, newId, { text: "新しい返信" });
    await finish(sql, c.salon.salonId, b.operation_id, b.lease_token, "failed");
    expect([(await detail(sql, c.salon.salonId, newId)).operation, (await detail(sql, c.salon.salonId, newId)).bucket]).toEqual(["send_failed", "unreplied"]);

    const x = await begin(sql, c.salon, delId, { action: "delete", base: sha("以前の返信") });
    await finish(sql, c.salon.salonId, x.operation_id, x.lease_token, "failed");
    expect([(await detail(sql, c.salon.salonId, delId)).operation, (await detail(sql, c.salon.salonId, delId)).bucket]).toEqual(["delete_failed", "attention"]);
  });

  it("送る直前に利用できなくなった・店舗が変わった操作は送らない(送り始める前は送信できなかった扱い)", async () => {
    const c = await syncedSalon(sql);
    await allowGoogleReviews(sql, c.salon.salonId);
    const id = c.rows[0].review_index_id;
    const r = await begin(sql, c.salon, id);
    await sql`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${c.salon.salonId} and feature_key = 'google_reviews'`;
    expect(await startSend(sql, c.salon.salonId, r.operation_id, r.lease_token)).toBe("not_entitled");
    const [op] = await sql`select status, error_code, send_started_at from public.gbp_reply_operations where id = ${r.operation_id}`;
    expect(op).toEqual({ status: "failed", error_code: "not_entitled", send_started_at: null });

    await sql`update public.salon_feature_overrides set mode = 'allow' where salon_id = ${c.salon.salonId} and feature_key = 'google_reviews'`;
    const r2 = await begin(sql, c.salon, id);
    const [{ location_name }] = await sql`select location_name from public.gbp_locations where id = ${c.locationId}`;
    await selectLocation(sql, c.salon, c.accountId, location_name);
    expect(await startSend(sql, c.salon.salonId, r2.operation_id, r2.lease_token)).toBe("location_changed");
  });

  it("送信の開始後に店舗が変わると、結果は記録だけ残り、一時保存・下書きに書き戻さない。同じ店舗を選び直すと「確認が必要」で追える", async () => {
    const c = await syncedSalon(sql);
    await allowGoogleReviews(sql, c.salon.salonId);
    const id = c.rows[0].review_index_id;
    const r = await begin(sql, c.salon, id);
    expect(await startSend(sql, c.salon.salonId, r.operation_id, r.lease_token)).toBe("ok");
    const [{ location_name }] = await sql`select location_name from public.gbp_locations where id = ${c.locationId}`;
    const newLocation = await selectLocation(sql, c.salon, c.accountId, location_name);
    // 古い処理の結果(受け付け)。記録は残すが、一時保存は書かない
    expect(await finish(sql, c.salon.salonId, r.operation_id, r.lease_token, "accepted", [review("past-a", { reply: "古い処理の返信" })])).toBe(true);
    expect((await sql`select 1 from public.gbp_review_cache where salon_id = ${c.salon.salonId}`).length).toBe(0);
    const [op] = await sql`select status, review_index_id, location_id from public.gbp_reply_operations where id = ${r.operation_id}`;
    expect(op.status).toBe("accepted");
    // 新しい世代で同じ口コミを取り込むと、送った操作の確認が必要と出る(推測で未返信・返信済みにしない)
    const rows = await ingest(sql, c.salon.salonId, newLocation, [review("past-a")]);
    const d = await detail(sql, c.salon.salonId, rows[0].review_index_id);
    expect([d.operation, d.bucket]).toEqual(["sent_checking", "attention"]);
  });

  it("同じ口コミに送っている途中の操作は1つだけ。1分の回数はロケーションごと", async () => {
    const c = await syncedSalon(sql, ["r1", "r2", "r3"]);
    await allowGoogleReviews(sql, c.salon.salonId);
    const first = await begin(sql, c.salon, c.rows[0].review_index_id);
    expect(first.outcome).toBe("new");
    expect((await begin(sql, c.salon, c.rows[0].review_index_id)).outcome).toBe("busy");
    expect((await begin(sql, c.salon, c.rows[1].review_index_id, { rate: 2 })).outcome).toBe("new");
    expect((await begin(sql, c.salon, c.rows[2].review_index_id, { rate: 2 })).outcome).toBe("rate_limited");
  });

  it("同じ op_id で本文・操作が違う要求は拒否する", async () => {
    const c = await syncedSalon(sql);
    await allowGoogleReviews(sql, c.salon.salonId);
    const opId = randomUUID();
    const r = await begin(sql, c.salon, c.rows[0].review_index_id, { opId, text: "A" });
    await finish(sql, c.salon.salonId, r.operation_id, r.lease_token, "failed");
    expect((await begin(sql, c.salon, c.rows[0].review_index_id, { opId, text: "B" })).outcome).toBe("mismatch");
    expect((await begin(sql, c.salon, c.rows[0].review_index_id, { opId, action: "delete" })).outcome).toBe("mismatch");
  });
});

describe("同時の接続(実 DB のロック)", () => {
  it("送る直前の確認と、利用不可への変更が重なっても、変更の確定のあとは送らない", async () => {
    const c = await syncedSalon(sql);
    await allowGoogleReviews(sql, c.salon.salonId);
    const r = await begin(sql, c.salon, c.rows[0].review_index_id);
    const c1 = await sql.reserve();
    try {
      await c1`begin`;
      await c1`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${c.salon.salonId} and feature_key = 'google_reviews'`;
      const send = startSend(sql, c.salon.salonId, r.operation_id, r.lease_token);
      await new Promise((res) => setTimeout(res, 300));
      await c1`commit`;
      expect(await send).toBe("not_entitled");
    } finally {
      c1.release();
    }
  });
});
