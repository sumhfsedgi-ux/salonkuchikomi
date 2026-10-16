// 店舗のオーナーのアカウントの削除(Supabase の認証の管理の削除。auth.users から店舗・口コミのデータへの cascade)が、
// 届いた口コミのデータ(結び付け・ロケーション・口コミ・返信の操作・同意)があっても失敗しないこと(npm run test:localdb)。
// Supabase では auth.users の削除は supabase_auth_admin(public の表・関数の権限を持たない)で行われるため、
// 同じように auth.users の削除だけを許した役割で削除する。値はすべて架空。
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDatabase, dropDatabase } from "./db";
import { createSalon } from "./fixtures";

const DB = "salonpack_localdb_account_deletion";
const ROLE = "salonpack_auth_admin_sim";
let sql: Sql;

beforeAll(async () => {
  sql = await createDatabase(DB);
  await sql.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${ROLE}') then create role ${ROLE} nologin; end if;
  end $$;`);
  await sql.unsafe(`grant usage on schema auth to ${ROLE}; grant select, delete on auth.users to ${ROLE};`);
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

describe("アカウントの削除と届いた口コミのデータ", () => {
  it("口コミの結び付け・ロケーション・口コミ・返信の操作・同意がある店舗のオーナーも、認証の管理の権限で削除できる", async () => {
    const salon = await createSalon(sql, { plan: "reviews" });
    const accountId = randomUUID();
    await sql`
      insert into public.google_accounts (id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv,
                                          refresh_token_tag, key_version, granted_scopes)
      values (${accountId}, 'test-client', ${`sub-${accountId.slice(0, 8)}`}, 'owner@example.test', 'c', 'i', 't', 'v1',
              ${["openid", "email", "https://www.googleapis.com/auth/business.manage"]})`;
    await sql`select * from public.google_bind_features(${salon.salonId}, ${accountId}, ${["gbp"]}, null, ${salon.userId},
                                                        ${["https://www.googleapis.com/auth/business.manage"]})`;
    const [{ id: locationId }] = await sql`
      select public.gbp_select_location(${salon.salonId}, ${accountId}, 'accounts/1', ${`locations/${randomUUID().slice(0, 8)}`},
                                        '架空の店', null, ${salon.userId}) as id`;
    await sql`select public.gbp_record_consent(${salon.salonId}, ${salon.userId}, 'v-test')`;
    await sql`update public.feature_catalog set lifecycle = 'available' where feature_key = 'google_reviews'`;
    await sql`insert into public.salon_feature_overrides (salon_id, feature_key, mode) values (${salon.salonId}, 'google_reviews', 'allow')`;
    const now = new Date().toISOString();
    const [{ review_index_id }] = await sql`
      select * from public.gbp_ingest_reviews(${salon.salonId}, ${locationId}, null, 'manual', ${sql.json([
        {
          review_key: "k".repeat(40),
          review_name: "accounts/1/locations/1/reviews/r1",
          reviewer_name: "架空",
          reviewer_photo_url: null,
          is_anonymous: false,
          star_rating: 5,
          comment: "(架空)",
          create_time: now,
          update_time: now,
          reply_comment: null,
          reply_update_time: null,
          reply_state: null,
          policy_violation: null,
          media: [],
          reply_url: null,
        },
      ] as never)}, 86400)`;
    const [op] = await sql`
      select * from public.gbp_begin_reply_operation(${randomUUID()}, ${salon.salonId}, ${review_index_id}, 'upsert',
        ${"a".repeat(64)}, 10, null, ${salon.userId}, 60, 10)`;
    expect(op.outcome).toBe("new");

    const deleter = await sql.reserve();
    try {
      await deleter`begin`;
      await deleter.unsafe(`set local role ${ROLE}`);
      await deleter`delete from auth.users where id = ${salon.userId}`;
      await deleter`commit`;
    } catch (err) {
      await deleter`rollback`.catch(() => undefined);
      throw err;
    } finally {
      deleter.release();
    }
    const [left] = await sql`
      select (select count(*) from public.salons where id = ${salon.salonId})::int as salons,
             (select count(*) from public.salon_google_bindings where salon_id = ${salon.salonId})::int as bindings,
             (select count(*) from public.gbp_locations where salon_id = ${salon.salonId})::int as locations,
             (select count(*) from public.gbp_reply_operations where salon_id = ${salon.salonId})::int as operations`;
    expect(left).toEqual({ salons: 0, bindings: 0, locations: 0, operations: 0 });
  });
});
