// 口コミ 第2段階(0033: 新着の自動取得と LINE 通知)の DB をローカルの PostgreSQL で確かめる(npm run test:localdb)。値はすべて架空。
//   - 新着のイベント: 初回の取り込みの分・編集・期限切れ後の取り直しはイベントにならない。同時の取り込みでも1件
//   - 評価: 開始前・選択前・ON にする前に投稿された口コミは送らない(遅れて検知・評価しても)。送る内容は店舗名と URL だけ
//   - 送信直前の確認: 停止・OFF・解除・再登録・利用許可の変更・利用区分・店舗の選び直し。試行済みは再試行だけ止める
//   - 停止と送信直前の確認の待ち合わせ(送信を始めた分は取り消せない件数として返す)
//   - 自動取得の対象・認証失敗の記録・結果の記録
//   - 期限の削除は通知の停止・利用可否に関係なく動く
//   - 権限: 関数は service role だけ
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { applyFile, createDatabase, dropDatabase, migrationFiles } from "./db";
import { createSalon, type SalonFixture } from "./fixtures";
import { createLocalRpcClient } from "./rpcClient";
import { createRpcReviewAlertStore } from "@/lib/reviews/alerts/store";
import { deliverReviewAlerts, evaluateReviewAlerts } from "@/lib/reviews/alerts/deliver";
import { createDeadline } from "@/lib/notifications/jobs/runBudget";
import type { LineSendResult } from "@/lib/notifications/line/LineClient";

const DB = "salonpack_localdb_review_alerts";
let sql: Sql;

const TTL = 25 * 24 * 3600;
const CONSENT = "gbp-connect-test-v3";
const BASE = "https://salonpack.example.test";

async function createAccount(db: Sql): Promise<string> {
  const id = randomUUID();
  const sub = `sub-${id.slice(0, 8)}`;
  await db`
    insert into public.google_accounts (id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv,
                                        refresh_token_tag, key_version, granted_scopes)
    values (${id}, 'test-client', ${sub}, ${`${sub}@example.test`}, 'c', 'i', 't', 'v1',
            ${["openid", "email", "https://www.googleapis.com/auth/business.manage"]})`;
  return id;
}

async function allowGoogleReviews(db: Sql, salonId: string) {
  await db`update public.feature_catalog set lifecycle = 'available' where feature_key = 'google_reviews'`;
  await db`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${salonId}, 'reviews', 'allow')
           on conflict (salon_id, feature_key) do update set mode = 'allow'`;
}

function review(key: string, createTime: Date = new Date(), comment = "(架空の口コミの本文)") {
  return {
    review_key: key.padEnd(40, "0"),
    review_name: `accounts/1/locations/100/reviews/${key}`,
    reviewer_name: "架空の投稿者",
    reviewer_photo_url: null,
    is_anonymous: false,
    star_rating: 2,
    comment,
    create_time: createTime.toISOString(),
    update_time: createTime.toISOString(),
    reply_comment: null,
    reply_update_time: null,
    reply_state: null,
    policy_violation: null,
    media: [],
    reply_url: null,
  };
}

async function ingest(db: Sql, salonId: string, locationId: string, reviews: unknown[], lease: string | null = null, via = "manual") {
  return db<{ review_index_id: string; created: boolean }[]>`
    select * from public.gbp_ingest_reviews(${salonId}, ${locationId}, ${lease}, ${via}, ${db.json(reviews as never)}, ${TTL})`;
}

async function initialSync(db: Sql, salonId: string, locationId: string, keys: string[]) {
  const [s] = await db<{ lease_token: string }[]>`select * from public.gbp_begin_sync(${salonId}, ${locationId}, 60, 1728000, 0, 3600)`;
  await ingest(db, salonId, locationId, keys.map((k) => review(k, new Date(Date.now() - 30 * 86400_000))), s.lease_token);
  await db`select public.gbp_finish_sync(${salonId}, ${locationId}, ${s.lease_token}, now(), 4.0, ${keys.length})`;
}

async function addRecipient(db: Sql, salonId: string, label = "スタッフ"): Promise<string> {
  const dest = `U${randomUUID().replace(/-/g, "")}`;
  const [lc] = await db<{ id: string }[]>`
    insert into public.line_connections (salon_id, destination_id, status, label, recipient_since)
    values (${salonId}, ${dest}, 'connected', ${label}, now())
    returning id`;
  return lc.id;
}

async function setRecipient(db: Sql, salon: SalonFixture, connectionId: string, on: boolean) {
  const [row] = await db<{ r: string }[]>`
    select public.review_alert_set_recipient(${salon.salonId}, ${connectionId}, ${on}, ${salon.userId}) as r`;
  return row.r;
}

async function settingsVersion(db: Sql, salonId: string): Promise<number> {
  const [row] = await db<{ version: number }[]>`select version from public.review_alert_settings where salon_id = ${salonId}`;
  return row?.version ?? 0;
}

async function start(db: Sql, salon: SalonFixture) {
  const v = await settingsVersion(db, salon.salonId);
  const [row] = await db<{ r: string }[]>`
    select public.review_alert_start(${salon.salonId}, ${salon.userId}, ${v}, ${CONSENT}) as r`;
  return row.r;
}

async function stop(db: Sql, salon: SalonFixture) {
  const [row] = await db<{ outcome: string; in_flight: number }[]>`
    select * from public.review_alert_stop(${salon.salonId}, ${salon.userId})`;
  return row;
}

async function settings(db: Sql, salonId: string) {
  const [row] = await db<{ enabled: boolean; stop_reason: string | null; epoch: number }[]>`
    select enabled, stop_reason, epoch from public.review_alert_settings where salon_id = ${salonId}`;
  return row;
}

async function eventsOf(db: Sql, salonId: string) {
  return db<{ id: string; decision: string; skip_reason: string | null; source: string; review_index_id: string | null }[]>`
    select id, decision, skip_reason, source, review_index_id from public.review_alert_events
     where salon_id = ${salonId} order by detected_at, id`;
}

async function evaluate(db: Sql, eventId: string) {
  const [row] = await db<{ r: string }[]>`select public.review_alert_evaluate(${eventId}, ${BASE}, ${CONSENT}) as r`;
  return row.r;
}

async function evaluateAll(db: Sql, salonId: string) {
  const out: string[] = [];
  for (const e of await eventsOf(db, salonId)) if (e.decision === "pending") out.push(await evaluate(db, e.id));
  return out;
}

async function deliveriesOf(db: Sql, salonId: string) {
  return db<{ id: string; status: string; skip_reason: string | null; line_connection_id: string; message: { salon_name: string; url: string }; retry_stopped_at: Date | null; attempts: number }[]>`
    select id, status, skip_reason, line_connection_id, message, retry_stopped_at, attempts
      from public.review_alert_deliveries where salon_id = ${salonId} order by created_at, id`;
}

interface Claimed {
  id: string;
  claim_token: string;
  salon_id: string;
}

/** 指定の店舗の配信だけを取り出す(ほかのテストの店舗の配信は戻す)。 */
async function claimFor(db: Sql, salonId: string): Promise<Claimed | null> {
  const others: Claimed[] = [];
  try {
    for (let i = 0; i < 50; i++) {
      const [row] = await db<Claimed[]>`select id, claim_token, salon_id from public.review_alert_claim()`;
      if (!row) return null;
      if (row.salon_id === salonId) return row;
      others.push(row);
    }
    return null;
  } finally {
    for (const o of others) await db`select public.review_alert_release_claim(${o.id}, ${o.claim_token})`;
  }
}

async function beginSend(db: Sql, c: Claimed) {
  const [row] = await db<{ decision: string; reason: string | null; message: unknown; destination_id: string | null }[]>`
    select * from public.review_alert_begin_send(${c.id}, ${c.claim_token}, ${CONSENT})`;
  return row;
}

async function finish(db: Sql, c: Claimed, outcome: string) {
  const [row] = await db<{ ok: boolean }[]>`
    select public.review_alert_finish(${c.id}, ${c.claim_token}, ${outcome}, ${outcome === "sent" ? "req-1" : null}, null, null) as ok`;
  return row.ok;
}

/** Google口コミを使える・同意済み・連携済み・初回の取り込み済み・口コミ通知 ON の通知先1人・通知中の店舗。 */
async function readySalon(db: Sql, opts: { start?: boolean; recipients?: number } = {}) {
  const salon = await createSalon(db, { plan: "reviews" });
  await allowGoogleReviews(db, salon.salonId);
  const accountId = await createAccount(db);
  await db`select * from public.google_bind_features(${salon.salonId}, ${accountId}, ${["gbp"]}, null, ${salon.userId},
                                                    ${["https://www.googleapis.com/auth/business.manage"]})`;
  await db`select public.gbp_record_consent(${salon.salonId}, ${salon.userId}, ${CONSENT})`;
  const [loc] = await db<{ id: string }[]>`
    select public.gbp_select_location(${salon.salonId}, ${accountId}, 'accounts/1', ${`locations/${randomUUID().slice(0, 8)}`},
                                      '架空の店', '架空の住所', ${salon.userId}) as id`;
  await initialSync(db, salon.salonId, loc.id, ["past-a", "past-b"]);
  const recipients: string[] = [];
  for (let i = 0; i < (opts.recipients ?? 1); i++) {
    const lc = await addRecipient(db, salon.salonId, `通知先${i + 1}`);
    await setRecipient(db, salon, lc, true);
    recipients.push(lc);
  }
  if (opts.start !== false) expect(await start(db, salon)).toBe("started");
  return { salon, accountId, locationId: loc.id, recipients };
}

/** 通知中の店舗に新しい口コミを1件取り込み、評価して、配信を1つ取り出す。 */
async function newReviewClaimed(db: Sql) {
  const r = await readySalon(db);
  await ingest(db, r.salon.salonId, r.locationId, [review(`new-${randomUUID().slice(0, 6)}`)]);
  expect(await evaluateAll(db, r.salon.salonId)).toEqual(["notify"]);
  const c = await claimFor(db, r.salon.salonId);
  expect(c).not.toBeNull();
  return { ...r, claimed: c! };
}

beforeAll(async () => {
  sql = await createDatabase(DB);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

describe("0033 の適用", () => {
  it("もう一度適用しても同じ結果になる(第1段階までの migration の上で)", async () => {
    const file = migrationFiles("0033").at(-1)!;
    expect(file).toMatch(/0033_review_alerts\.sql$/);
    await applyFile(sql, file);
  });

  it("関数は service role だけが実行できる・表はブラウザのロールから読めない", async () => {
    const rows = await sql<{ name: string; anon: boolean; authenticated: boolean; service: boolean }[]>`
      select p.proname as name,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'review_alert_%' or p.proname like 'gbp_auto_%')
         and p.proname not like 'review_alert_on_%'`;
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect({ name: r.name, anon: r.anon, authenticated: r.authenticated, service: r.service })
      .toEqual({ name: r.name, anon: false, authenticated: false, service: true });
    const [t] = await sql<{ ok: boolean }[]>`
      select bool_or(has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select')) as ok
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and (c.relname like 'review_alert_%' or c.relname like 'gbp_auto_%') and c.relkind = 'r'`;
    expect(t.ok).toBe(false);
  });
});

describe("新着のイベント(第1段階の「新着」と同じ起点)", () => {
  it("初回の取り込みの分はイベントにならず、初回のあとに初めて見つけた口コミだけ1件になる", async () => {
    const r = await readySalon(sql, { start: false });
    expect(await eventsOf(sql, r.salon.salonId)).toEqual([]);
    await ingest(sql, r.salon.salonId, r.locationId, [review("fresh-1")], null, "reconcile");
    const events = await eventsOf(sql, r.salon.salonId);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("reconcile");
  });

  it("投稿者の編集(同じ口コミの取り直し)・期限切れのあとの取り直しは、イベントを増やさない", async () => {
    const r = await readySalon(sql, { start: false });
    await ingest(sql, r.salon.salonId, r.locationId, [review("edit-1")]);
    await ingest(sql, r.salon.salonId, r.locationId, [review("edit-1", new Date(), "(編集後の架空の本文)")]);
    await sql`delete from public.gbp_review_cache where salon_id = ${r.salon.salonId}`;
    await ingest(sql, r.salon.salonId, r.locationId, [review("edit-1"), review("past-a")]);
    expect(await eventsOf(sql, r.salon.salonId)).toHaveLength(1);
  });

  it("手動の更新と自動取得が同じ新しい口コミを同時に取り込んでも、イベントは1件", async () => {
    const r = await readySalon(sql, { start: false });
    const reviews = [review("same-1")];
    await Promise.all([
      sql.begin((tx) => ingest(tx as unknown as Sql, r.salon.salonId, r.locationId, reviews, null, "manual")),
      sql.begin((tx) => ingest(tx as unknown as Sql, r.salon.salonId, r.locationId, reviews, null, "reconcile")),
    ]);
    expect(await eventsOf(sql, r.salon.salonId)).toHaveLength(1);
  });
});

describe("開始と評価", () => {
  it("口コミ通知が ON の通知先がいなければ開始できない。同意が古い・初回の取り込み前も開始できない", async () => {
    const r = await readySalon(sql, { start: false, recipients: 0 });
    expect(await start(sql, r.salon)).toBe("no_recipients");
    const lc = await addRecipient(sql, r.salon.salonId);
    expect(await setRecipient(sql, r.salon, lc, true)).toBe("updated");
    expect(await setRecipient(sql, r.salon, lc, true)).toBe("unchanged");
    const [bad] = await sql<{ r: string }[]>`
      select public.review_alert_start(${r.salon.salonId}, ${r.salon.userId}, ${await settingsVersion(sql, r.salon.salonId)}, 'old-version') as r`;
    expect(bad.r).toBe("consent_required");
    const [stale] = await sql<{ r: string }[]>`
      select public.review_alert_start(${r.salon.salonId}, ${r.salon.userId}, 999, ${CONSENT}) as r`;
    expect(stale.r).toBe("changed");
    expect(await start(sql, r.salon)).toBe("started");
  });

  it("新しい口コミを、ON の通知先ごとに1つの配信にする。送る内容は店舗名と確認用の URL だけ", async () => {
    const r = await readySalon(sql, { recipients: 2 });
    const [row] = await ingest(sql, r.salon.salonId, r.locationId, [review("notify-1", new Date(), "電話 090-0000-0000 本文")]);
    expect(await evaluateAll(sql, r.salon.salonId)).toEqual(["notify"]);
    const ds = await deliveriesOf(sql, r.salon.salonId);
    expect(ds).toHaveLength(2);
    const [salonRow] = await sql<{ name: string }[]>`select name from public.salons where id = ${r.salon.salonId}`;
    for (const d of ds) {
      expect(d.status).toBe("pending");
      expect(d.message).toEqual({ salon_name: salonRow.name, url: `${BASE}/dashboard/reviews/google/${row.review_index_id}` });
    }
    expect(JSON.stringify(ds.map((d) => d.message))).not.toMatch(/架空の投稿者|090|本文|★/);
    // 同じイベントをもう一度評価しても増えない
    const [e] = await eventsOf(sql, r.salon.salonId);
    expect(await evaluate(sql, e.id)).toBe("already_decided");
    expect(await deliveriesOf(sql, r.salon.salonId)).toHaveLength(2);
  });

  it("開始より前・ON にする前に投稿された口コミは、遅れて検知・評価しても送らない", async () => {
    const r = await readySalon(sql, { recipients: 1 });
    const before = new Date(Date.now() - 60_000);
    await ingest(sql, r.salon.salonId, r.locationId, [review("late-1", before)]);
    expect(await evaluateAll(sql, r.salon.salonId)).toEqual(["skipped:before_start"]);

    // 2人目は後から ON にする。その前に投稿された口コミ(検知は ON のあと)は、2人目には送らない
    await sql`update public.review_alert_settings set notify_from = now() - interval '1 hour' where salon_id = ${r.salon.salonId}`;
    await sql`update public.gbp_locations set activated_at = now() - interval '1 hour' where id = ${r.locationId}`;
    await sql`update public.review_alert_recipients set on_since = now() - interval '1 hour' where line_connection_id = ${r.recipients[0]}`;
    await sql`update public.line_connections set recipient_since = now() - interval '1 hour' where id = ${r.recipients[0]}`;
    const lc2 = await addRecipient(sql, r.salon.salonId, "後から");
    await sql`update public.line_connections set recipient_since = now() - interval '2 hours' where id = ${lc2}`;
    await setRecipient(sql, r.salon, lc2, true);
    await ingest(sql, r.salon.salonId, r.locationId, [review("late-2", new Date(Date.now() - 30_000))]);
    expect(await evaluateAll(sql, r.salon.salonId)).toEqual(["notify"]);
    const ds = await deliveriesOf(sql, r.salon.salonId);
    expect(ds.map((d) => d.line_connection_id)).toEqual([r.recipients[0]]);
  });

  it("投稿から72時間を超えて検知した口コミ・検知から24時間を超えて評価した口コミは送らない", async () => {
    const r = await readySalon(sql);
    await sql`update public.review_alert_settings set notify_from = now() - interval '10 days' where salon_id = ${r.salon.salonId}`;
    await sql`update public.gbp_locations set activated_at = now() - interval '10 days' where id = ${r.locationId}`;
    await sql`update public.review_alert_recipients set on_since = now() - interval '10 days' where salon_id = ${r.salon.salonId}`;
    await sql`update public.line_connections set recipient_since = now() - interval '10 days' where salon_id = ${r.salon.salonId}`;
    await ingest(sql, r.salon.salonId, r.locationId, [review("old-1", new Date(Date.now() - 4 * 86400_000))]);
    await ingest(sql, r.salon.salonId, r.locationId, [review("old-2", new Date(Date.now() - 3600_000))]);
    await sql`update public.review_alert_events set detected_at = now() - interval '25 hours'
               where review_index_id = (select i.id from public.gbp_review_index i where i.location_id = ${r.locationId}
                                         and i.review_key_hash = ${"old-2".padEnd(40, "0")})`;
    expect((await evaluateAll(sql, r.salon.salonId)).sort()).toEqual(["skipped:stale", "skipped:too_old"]);
  });

  it("通知が止まっている間の口コミは skipped(alerts_off)", async () => {
    const r = await readySalon(sql, { start: false });
    await ingest(sql, r.salon.salonId, r.locationId, [review("off-1")]);
    expect(await evaluateAll(sql, r.salon.salonId)).toEqual(["skipped:alerts_off"]);
  });
});

describe("送信直前の確認", () => {
  it("条件がそろえば send。送信を始めたら finish で送信済みにでき、同じ配信は二度と取り出さない", async () => {
    const r = await newReviewClaimed(sql);
    const b = await beginSend(sql, r.claimed);
    expect(b.decision).toBe("send");
    expect(await finish(sql, r.claimed, "sent")).toBe(true);
    expect(await claimFor(sql, r.salon.salonId)).toBeNull();
  });

  it("取り出したあとに停止されたら送らない(skipped)", async () => {
    const r = await newReviewClaimed(sql);
    expect((await stop(sql, r.salon)).outcome).toBe("stopped");
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "alerts_off" });
  });

  it("停止は、送信を始めていない配信を送らないようにし、送信を始めた分を取り消せない件数として返す", async () => {
    const r = await readySalon(sql, { recipients: 2 });
    await ingest(sql, r.salon.salonId, r.locationId, [review("stop-1")]);
    await evaluateAll(sql, r.salon.salonId);
    const c = (await claimFor(sql, r.salon.salonId))!;
    expect((await beginSend(sql, c)).decision).toBe("send");
    const res = await stop(sql, r.salon);
    expect(res).toEqual({ outcome: "stopped", in_flight: 1 });
    const ds = await deliveriesOf(sql, r.salon.salonId);
    expect(ds.map((d) => d.status).sort()).toEqual(["claimed", "skipped"]);
  });

  it("送信直前の確認の途中に停止が来たら、停止は確認の終わりを待ち、送信を始めた1件を返す", async () => {
    const r = await newReviewClaimed(sql);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let decided!: () => void;
    const decidedP = new Promise<void>((resolve) => (decided = resolve));
    const tx1 = sql.begin(async (tx) => {
      const row = await beginSend(tx as unknown as Sql, r.claimed);
      decided();
      await gate;
      return row;
    });
    await decidedP;
    const stopP = stop(sql, r.salon);
    const raced = await Promise.race([stopP.then(() => "stop-finished"), new Promise((ok) => setTimeout(() => ok("waiting"), 300))]);
    expect(raced).toBe("waiting");
    release();
    expect((await tx1).decision).toBe("send");
    expect(await stopP).toEqual({ outcome: "stopped", in_flight: 1 });
  });

  it("試行済みの配信は、OFF にすると再試行を止め、ON に戻しても復活しない", async () => {
    const r = await newReviewClaimed(sql);
    expect((await beginSend(sql, r.claimed)).decision).toBe("send");
    expect(await finish(sql, r.claimed, "unknown")).toBe(true);
    await sql`update public.review_alert_deliveries set next_attempt_at = now() where salon_id = ${r.salon.salonId}`;
    expect(await setRecipient(sql, r.salon, r.recipients[0], false)).toBe("updated");
    expect(await setRecipient(sql, r.salon, r.recipients[0], true)).toBe("updated");
    expect(await claimFor(sql, r.salon.salonId)).toBeNull();
    const [d] = await deliveriesOf(sql, r.salon.salonId);
    expect(d.status).toBe("unknown");
    expect(d.retry_stopped_at).not.toBeNull();
  });

  it("OFF→ON の間に取り出されていた配信も、ON にした時刻が変わったので送らない", async () => {
    const r = await newReviewClaimed(sql);
    await setRecipient(sql, r.salon, r.recipients[0], false);
    await setRecipient(sql, r.salon, r.recipients[0], true);
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "recipient_off" });
  });

  it("通知先を解除したら送らない(0023 の解除はそのまま動く)。試行済みなら再試行だけ止める", async () => {
    const r = await newReviewClaimed(sql);
    const [rm] = await sql<{ r: string }[]>`select public.line_recipient_remove(${r.salon.salonId}, ${r.recipients[0]}, 'test') as r`;
    expect(rm.r).toBe("removed");
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "recipient_removed" });

    const r2 = await newReviewClaimed(sql);
    expect((await beginSend(sql, r2.claimed)).decision).toBe("send");
    await finish(sql, r2.claimed, "unknown");
    await sql`update public.review_alert_deliveries set next_attempt_at = now() where salon_id = ${r2.salon.salonId}`;
    await sql`select public.line_recipient_remove(${r2.salon.salonId}, ${r2.recipients[0]}, 'test')`;
    const c = (await claimFor(sql, r2.salon.salonId))!;
    expect(await beginSend(sql, c)).toMatchObject({ decision: "released", reason: "retry_stopped:recipient_removed" });
    expect(await claimFor(sql, r2.salon.salonId)).toBeNull();
  });

  it("再登録した通知先(世代が変わった)は口コミ通知が OFF 扱いになり、送らない", async () => {
    const r = await newReviewClaimed(sql);
    await sql`update public.line_connections set registration_generation = registration_generation + 1, recipient_since = now()
               where id = ${r.recipients[0]}`;
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "recipient_reregistered" });
    const [count] = await sql<{ n: number }[]>`select public.review_alert_active_recipient_count(${r.salon.salonId}) as n`;
    expect(count.n).toBe(0);
  });

  it("利用許可が無くなると LINE 通知が止まり(再許可だけでは再開しない)、送らない", async () => {
    const r = await newReviewClaimed(sql);
    await sql`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${r.salon.salonId} and feature_key = 'reviews'`;
    expect(await settings(sql, r.salon.salonId)).toMatchObject({ enabled: false, stop_reason: "entitlement" });
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "not_entitled" });
    await sql`update public.salon_feature_overrides set mode = 'allow' where salon_id = ${r.salon.salonId} and feature_key = 'reviews'`;
    expect((await settings(sql, r.salon.salonId)).enabled).toBe(false);
  });

  it("利用区分が利用開始待ちに戻っても止まる", async () => {
    const r = await newReviewClaimed(sql);
    await sql`update public.salons set service_status = 'pending' where id = ${r.salon.salonId}`;
    expect(await settings(sql, r.salon.salonId)).toMatchObject({ enabled: false, stop_reason: "entitlement" });
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "not_entitled" });
  });

  it("店舗の選び直しで LINE 通知が止まり(再開が必要)、前の世代の配信は送らない", async () => {
    const r = await newReviewClaimed(sql);
    const [changed] = await sql<{ ok: boolean }[]>`select public.gbp_begin_location_change(${r.salon.salonId}, ${r.accountId}) as ok`;
    expect(changed.ok).toBe(true);
    expect(await settings(sql, r.salon.salonId)).toMatchObject({ enabled: false, stop_reason: "target_changed" });
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "alerts_off" });
  });

  it("停止と再開のあと、前の開始の配信は送らない(restarted)", async () => {
    const r = await newReviewClaimed(sql);
    await sql`update public.review_alert_settings set epoch = epoch + 1 where salon_id = ${r.salon.salonId}`;
    expect(await beginSend(sql, r.claimed)).toMatchObject({ decision: "skipped", reason: "restarted" });
  });

  it("送信を始めたまま処理権の期限が切れたら結果不明にし、同じ配信を同じキーで再試行できる", async () => {
    const r = await newReviewClaimed(sql);
    expect((await beginSend(sql, r.claimed)).decision).toBe("send");
    await sql`update public.review_alert_deliveries set claimed_at = now() - interval '5 minutes' where id = ${r.claimed.id}`;
    const [{ key: before }] = await sql<{ key: string }[]>`select line_retry_key as key from public.review_alert_deliveries where id = ${r.claimed.id}`;
    expect(await claimFor(sql, r.salon.salonId)).toBeNull(); // 1分の待ち
    const [d] = await deliveriesOf(sql, r.salon.salonId);
    expect(d.status).toBe("unknown");
    await sql`update public.review_alert_deliveries set next_attempt_at = now() where id = ${r.claimed.id}`;
    const c = (await claimFor(sql, r.salon.salonId))!;
    expect(c.id).toBe(r.claimed.id);
    expect((await beginSend(sql, c)).decision).toBe("send");
    const [{ key: after }] = await sql<{ key: string }[]>`select line_retry_key as key from public.review_alert_deliveries where id = ${r.claimed.id}`;
    expect(after).toBe(before);
  });

  it("送信を試みてから23時間を過ぎた結果不明は、自動では送り直さない(expired)", async () => {
    const r = await newReviewClaimed(sql);
    expect((await beginSend(sql, r.claimed)).decision).toBe("send");
    await finish(sql, r.claimed, "unknown");
    await sql`update public.review_alert_deliveries set first_attempt_at = now() - interval '24 hours', next_attempt_at = now()
               where id = ${r.claimed.id}`;
    expect(await claimFor(sql, r.salon.salonId)).toBeNull();
    await sql`select public.review_alert_purge()`;
    const [d] = await deliveriesOf(sql, r.salon.salonId);
    expect(d.status).toBe("expired");
  });
});

describe("自動取得", () => {
  it("使える店舗の世代だけが対象。認証失敗が同じトークンの世代で2回続いたら外れ、再連携(世代が進む)で戻る", async () => {
    const r = await readySalon(sql, { start: false });
    const due = async () =>
      (await sql<{ location_id: string }[]>`select * from public.gbp_auto_due_locations(${CONSENT}, 500)`).map((x) => x.location_id);
    expect(await due()).toContain(r.locationId);
    const [{ g }] = await sql<{ g: number }[]>`select token_generation as g from public.google_accounts where id = ${r.accountId}`;
    await sql`select public.gbp_auto_auth_record(${r.accountId}, ${g}, false)`;
    expect(await due()).toContain(r.locationId);
    await sql`select public.gbp_auto_auth_record(${r.accountId}, ${g}, false)`;
    expect(await due()).not.toContain(r.locationId);
    // アカウントの認証状態は変えない(予約通知の判定に影響させない)
    const [acc] = await sql<{ auth_state: string; consecutive_auth_failures: number }[]>`
      select auth_state, consecutive_auth_failures from public.google_accounts where id = ${r.accountId}`;
    expect(acc).toEqual({ auth_state: "active", consecutive_auth_failures: 0 });
    await sql`update public.google_accounts set token_generation = token_generation + 1 where id = ${r.accountId}`;
    expect(await due()).toContain(r.locationId);
  });

  it("同意が古い・利用許可が無い店舗は対象にしない", async () => {
    const r = await readySalon(sql, { start: false });
    const ids = async (version: string) =>
      (await sql<{ location_id: string }[]>`select * from public.gbp_auto_due_locations(${version}, 500)`).map((x) => x.location_id);
    expect(await ids("old-version")).not.toContain(r.locationId);
    await sql`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${r.salon.salonId} and feature_key = 'reviews'`;
    expect(await ids(CONSENT)).not.toContain(r.locationId);
  });

  it("結果の記録で次の予定が決まる(完了は間隔のあと・途中はすぐ・Google の通知は最初からの同期で済みになる)", async () => {
    const r = await readySalon(sql, { start: false });
    const [{ at }] = await sql<{ at: Date }[]>`select public.gbp_auto_begin(${r.salon.salonId}, ${r.locationId}) as at`;
    await sql`update public.gbp_auto_sync set requested_at = ${at} where location_id = ${r.locationId}`;
    await sql`select public.gbp_auto_finish(${r.locationId}, 'complete', ${at}, false, 900, null)`;
    const row = async () => {
      const [x] = await sql<{ requested: boolean; due_in: number; failures: number }[]>`
        select requested_at is not null as requested, extract(epoch from next_due_at - now())::int as due_in,
               consecutive_failures as failures
          from public.gbp_auto_sync where location_id = ${r.locationId}`;
      return x;
    };
    expect(await row()).toMatchObject({ requested: true });
    expect((await row()).due_in).toBeLessThanOrEqual(1);
    await sql`select public.gbp_auto_finish(${r.locationId}, 'complete', ${at}, true, 900, null)`;
    expect(await row()).toMatchObject({ requested: false });
    expect((await row()).due_in).toBeGreaterThan(800);
    await sql`select public.gbp_auto_finish(${r.locationId}, 'failed', ${at}, false, 1800, 'unavailable')`;
    expect(await row()).toMatchObject({ failures: 1 });
  });
});

describe("期限の削除", () => {
  it("通知の停止・利用可否に関係なく、30日を過ぎた記録を消す", async () => {
    const r = await newReviewClaimed(sql);
    await beginSend(sql, r.claimed);
    await finish(sql, r.claimed, "sent");
    await stop(sql, r.salon);
    await sql`update public.salon_feature_overrides set mode = 'deny' where salon_id = ${r.salon.salonId} and feature_key = 'reviews'`;
    await sql`update public.review_alert_deliveries set created_at = now() - interval '31 days' where salon_id = ${r.salon.salonId}`;
    await sql`update public.review_alert_events set detected_at = now() - interval '31 days' where salon_id = ${r.salon.salonId}`;
    const [res] = await sql<{ r: Record<string, number> }[]>`select public.review_alert_purge() as r`;
    expect(res.r.deliveries).toBeGreaterThanOrEqual(1);
    expect(await deliveriesOf(sql, r.salon.salonId)).toEqual([]);
    expect(await eventsOf(sql, r.salon.salonId)).toEqual([]);
  });

  it("作ってから24時間を過ぎても送信を始めていない配信は skipped(stale)", async () => {
    const r = await readySalon(sql);
    await ingest(sql, r.salon.salonId, r.locationId, [review(`st-${randomUUID().slice(0, 4)}`)]);
    await evaluateAll(sql, r.salon.salonId);
    await sql`update public.review_alert_deliveries set created_at = now() - interval '25 hours' where salon_id = ${r.salon.salonId}`;
    await sql`select public.review_alert_purge()`;
    const [d] = await deliveriesOf(sql, r.salon.salonId);
    expect(d).toMatchObject({ status: "skipped", skip_reason: "stale" });
  });
});

describe("テスト通知の連打防止", () => {
  it("10秒に1回だけ true", async () => {
    const salon = await createSalon(sql);
    const slot = async () => (await sql<{ ok: boolean }[]>`select public.review_alert_test_slot(${salon.salonId}) as ok`)[0].ok;
    expect(await slot()).toBe(true);
    expect(await slot()).toBe(false);
  });
});

describe("評価と配信の流れ(アプリの部品と本物の SQL。LINE はモック)", () => {
  async function drain() {
    // ほかのテストの店舗の配信は送らないよう、通知を止めておく
    await sql`update public.review_alert_settings set enabled = false`;
    await sql`update public.review_alert_deliveries set status = 'skipped', skip_reason = 'test_reset'
               where status in ('pending', 'unknown', 'retry_wait', 'claimed')`;
    await sql`update public.review_alert_events set decision = 'skipped' where decision = 'pending'`;
  }

  it("新しい口コミ1件を、ON の通知先ごとに1回だけ送る。次の回は何も送らない", async () => {
    await drain();
    const r = await readySalon(sql, { recipients: 2 });
    await ingest(sql, r.salon.salonId, r.locationId, [review(`flow-${randomUUID().slice(0, 4)}`)]);
    const store = createRpcReviewAlertStore(createLocalRpcClient(sql));
    const ev = await evaluateReviewAlerts({ store, baseUrl: BASE, consentVersion: CONSENT, deadline: createDeadline(45_000) });
    expect(ev).toMatchObject({ evaluated: 1, notify: 1 });
    const sent: { dest: string; key: string; url: string }[] = [];
    const sender = async (dest: string, message: { url: string }, key: string): Promise<LineSendResult> => {
      sent.push({ dest, key, url: message.url });
      return { outcome: "sent", requestId: `req-${sent.length}` };
    };
    const s1 = await deliverReviewAlerts({ store, send: sender, consentVersion: CONSENT, deadline: createDeadline(45_000) });
    expect(s1.sent).toBe(2);
    expect(new Set(sent.map((x) => x.dest)).size).toBe(2);
    const s2 = await deliverReviewAlerts({ store, send: sender, consentVersion: CONSENT, deadline: createDeadline(45_000) });
    expect(s2.sent).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("結果不明は同じ retry key・同じ内容で送り直し、LINE が受付済み(409)と答えたら送信済みにする", async () => {
    await drain();
    const r = await readySalon(sql);
    await ingest(sql, r.salon.salonId, r.locationId, [review(`retry-${randomUUID().slice(0, 4)}`)]);
    const store = createRpcReviewAlertStore(createLocalRpcClient(sql));
    await evaluateReviewAlerts({ store, baseUrl: BASE, consentVersion: CONSENT, deadline: createDeadline(45_000) });
    const attempts: { key: string; message: unknown }[] = [];
    const answers: LineSendResult[] = [{ outcome: "unknown", reason: "timeout" }, { outcome: "sent", requestId: "accepted-1" }];
    const sender = async (_dest: string, message: unknown, key: string) => {
      attempts.push({ key, message });
      return answers.shift()!;
    };
    expect((await deliverReviewAlerts({ store, send: sender, consentVersion: CONSENT, deadline: createDeadline(45_000) })).unknown).toBe(1);
    await sql`update public.review_alert_deliveries set next_attempt_at = now() where salon_id = ${r.salon.salonId}`;
    expect((await deliverReviewAlerts({ store, send: sender, consentVersion: CONSENT, deadline: createDeadline(45_000) })).sent).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const [d] = await deliveriesOf(sql, r.salon.salonId);
    expect(d.status).toBe("sent");
  });

  it("停止したあとは、結果不明の配信も送り直さない(取り消せない分は記録のまま残る)", async () => {
    await drain();
    const r = await readySalon(sql);
    await ingest(sql, r.salon.salonId, r.locationId, [review(`halt-${randomUUID().slice(0, 4)}`)]);
    const store = createRpcReviewAlertStore(createLocalRpcClient(sql));
    await evaluateReviewAlerts({ store, baseUrl: BASE, consentVersion: CONSENT, deadline: createDeadline(45_000) });
    let calls = 0;
    const sender = async (): Promise<LineSendResult> => {
      calls++;
      return { outcome: "unknown", reason: "timeout" };
    };
    await deliverReviewAlerts({ store, send: sender, consentVersion: CONSENT, deadline: createDeadline(45_000) });
    expect((await stop(sql, r.salon)).in_flight).toBe(1);
    await sql`update public.review_alert_deliveries set next_attempt_at = now() where salon_id = ${r.salon.salonId}`;
    await deliverReviewAlerts({ store, send: sender, consentVersion: CONSENT, deadline: createDeadline(45_000) });
    expect(calls).toBe(1);
    const [d] = await deliveriesOf(sql, r.salon.salonId);
    expect(d.status).toBe("unknown");
    expect(d.retry_stopped_at).not.toBeNull();
  });
});
