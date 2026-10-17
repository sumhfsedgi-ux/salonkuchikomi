// 口コミ作成中の表示(0033)をローカルの PostgreSQL で確かめる(npm run test:localdb)。値はすべて架空。
//   - 0033 は何度実行しても同じ結果になる(storage スキーマの無い DB でも通る)
//   - 表はブラウザ(anon / authenticated)から読み書きできない(自店舗の行も)
//   - 公開用のビューは、有効で写真とコピーがあり、口コミを使える店舗の行だけを返す(ビューを通した書き込みはできない)
//   - 写真のパスは自店舗の salon_id で始まる形だけ、有効にできるのは写真とコピーがあるときだけ
//   - イベントの種類に review_copied・google_opened が入り、それ以外は入らない
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { ROOT, applyFile, createDatabase, dropDatabase } from "./db";
import { adminSave, createOperator, createSalon, createSession, type SalonFixture } from "./fixtures";

const DB = "salonpack_localdb_showcase";
const MIGRATION = path.join(ROOT, "supabase", "migrations", "0033_review_generation_showcase.sql");
let sql: Sql;
let operator: string;
let shown: SalonFixture;
let disabled: SalonFixture;
let stopped: SalonFixture;
const claimsOf = new Map<string, string>();

const imagePath = (salonId: string) => `${salonId}/${randomUUID()}.jpg`;

beforeAll(async () => {
  sql = await createDatabase(DB);
  operator = await createOperator(sql);
  shown = await createSalon(sql);
  disabled = await createSalon(sql);
  stopped = await createSalon(sql);
  for (const s of [shown, disabled, stopped]) claimsOf.set(s.userId, (await createSession(sql, s.userId)).claims);
  await sql`insert into public.review_generation_showcases (salon_id, enabled, catch_copy, image_path)
            values (${shown.salonId}, true, '忙しい毎日に、自分をいたわる時間を。', ${imagePath(shown.salonId)}),
                   (${disabled.salonId}, false, 'サロンのあとも、心地よい毎日へ。', ${imagePath(disabled.salonId)}),
                   (${stopped.salonId}, true, 'あなたの「こうなりたい」を、一緒に。', ${imagePath(stopped.salonId)})`;
  // 運営が口コミを個別に利用不可にした店舗(salon_public.reviews_available = false と同じ状態)。
  await adminSave(sql, {
    actor: operator,
    salonId: stopped.salonId,
    expectedVersion: 0,
    expected: { plan: "salonpack", overrides: { reviews: "inherit" } },
    changes: { overrides: { reviews: "deny" } },
  });
});
afterAll(async () => {
  await dropDatabase(sql, DB);
});

/** ロールを切り替えたトランザクションで fn を実行し、最後に必ず取り消す。失敗したときはそのエラーを返す。 */
async function run(
  role: "anon" | "authenticated",
  userId: string | null,
  fn: (tx: TransactionSql) => Promise<unknown>,
): Promise<{ result: unknown; error: unknown }> {
  let result: unknown = null;
  let error: unknown = null;
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      if (userId) {
        await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
        await tx`select set_config('request.jwt.claims', ${claimsOf.get(userId) ?? JSON.stringify({ sub: userId })}, true)`;
      }
      try {
        result = await fn(tx);
      } catch (e) {
        error = e;
      }
      throw new Error("__rollback__");
    })
    .catch((e) => {
      if ((e as Error).message !== "__rollback__") throw e;
    });
  return { result, error };
}

describe("0033 の適用", () => {
  it("もう一度実行しても失敗せず、行もそのまま残る", async () => {
    await applyFile(sql, MIGRATION);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from public.review_generation_showcases`;
    expect(row.n).toBe(3);
  });

  it("既存の店舗には行が無い(未設定・無効から始まる)", async () => {
    const other = await createSalon(sql);
    const rows = await sql`select 1 from public.review_generation_showcases where salon_id = ${other.salonId}`;
    expect(rows).toHaveLength(0);
  });
});

describe("表の権限", () => {
  it("anon は読めず、書けない", async () => {
    expect((await run("anon", null, (tx) => tx`select * from public.review_generation_showcases`)).error).toBeTruthy();
    expect(
      (await run("anon", null, (tx) => tx`update public.review_generation_showcases set enabled = false`)).error,
    ).toBeTruthy();
  });

  it("オーナー(authenticated)も、自店舗・他店舗とも直接は読み書きできない", async () => {
    const owner = disabled.userId;
    expect((await run("authenticated", owner, (tx) => tx`select * from public.review_generation_showcases`)).error).toBeTruthy();
    for (const target of [disabled, shown]) {
      const { error } = await run(
        "authenticated",
        owner,
        (tx) => tx`update public.review_generation_showcases set catch_copy = '書き換え' where salon_id = ${target.salonId}`,
      );
      expect(error).toBeTruthy();
    }
    const unset = (await createSalon(sql)).salonId;
    const insert = await run(
      "authenticated",
      owner,
      (tx) => tx`insert into public.review_generation_showcases (salon_id) values (${unset})`,
    );
    expect(insert.error).toBeTruthy();
  });
});

describe("公開用のビュー(review_showcase_public)", () => {
  it("anon は、有効で口コミを使える店舗の行だけ読める(無効・利用停止の店舗は出ない)", async () => {
    const { result, error } = await run(
      "anon",
      null,
      (tx) => tx`select salon_id, catch_copy, image_path from public.review_showcase_public order by salon_id`,
    );
    expect(error).toBeNull();
    const rows = result as Array<{ salon_id: string; catch_copy: string; image_path: string }>;
    expect(rows.map((r) => r.salon_id)).toEqual([shown.salonId]);
    expect(rows[0].catch_copy).toBe("忙しい毎日に、自分をいたわる時間を。");
    expect(rows[0].image_path.startsWith(`${shown.salonId}/`)).toBe(true);
  });

  it("返す列は salon_id・キャッチコピー・写真のパスだけ", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'review_showcase_public' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual(["salon_id", "catch_copy", "image_path"]);
  });

  it("ビューを通して書き込めない(anon・authenticated)", async () => {
    expect(
      (await run("anon", null, (tx) => tx`update public.review_showcase_public set catch_copy = 'x' where salon_id = ${shown.salonId}`)).error,
    ).toBeTruthy();
    expect(
      (
        await run(
          "authenticated",
          shown.userId,
          (tx) => tx`delete from public.review_showcase_public where salon_id = ${shown.salonId}`,
        )
      ).error,
    ).toBeTruthy();
  });

  it("無効にすると出なくなり、口コミの利用を戻すと出る", async () => {
    await sql`update public.review_generation_showcases set enabled = false where salon_id = ${shown.salonId}`;
    const off = await run("anon", null, (tx) => tx`select salon_id from public.review_showcase_public`);
    expect(off.result).toEqual([]);
    await sql`update public.review_generation_showcases set enabled = true where salon_id = ${shown.salonId}`;

    await adminSave(sql, {
      actor: operator,
      salonId: stopped.salonId,
      expectedVersion: 1,
      expected: { plan: "salonpack", overrides: { reviews: "deny" } },
      changes: { overrides: { reviews: "inherit" } },
    });
    const on = await run("anon", null, (tx) => tx`select salon_id from public.review_showcase_public order by salon_id`);
    expect((on.result as Array<{ salon_id: string }>).map((r) => r.salon_id).sort()).toEqual(
      [shown.salonId, stopped.salonId].sort(),
    );
  });
});

describe("値の制約", () => {
  it("写真のパスは自店舗の salon_id で始まる形だけ", async () => {
    const bad = [`${shown.salonId}/${randomUUID()}.jpg`, "../x.jpg", `${disabled.salonId}/a.gif`];
    // 他店舗の salon_id で始まるパスは入らない。
    await expect(
      sql`update public.review_generation_showcases set image_path = ${bad[0]} where salon_id = ${disabled.salonId}`,
    ).rejects.toThrow();
    await expect(
      sql`update public.review_generation_showcases set image_path = ${bad[1]} where salon_id = ${disabled.salonId}`,
    ).rejects.toThrow();
    await expect(
      sql`update public.review_generation_showcases set image_path = ${bad[2]} where salon_id = ${disabled.salonId}`,
    ).rejects.toThrow();
  });

  it("有効にできるのは写真とコピーがあるときだけ・コピーは30文字以内で改行なし", async () => {
    await expect(
      sql`update public.review_generation_showcases set image_path = null where salon_id = ${shown.salonId}`,
    ).rejects.toThrow();
    await expect(
      sql`update public.review_generation_showcases set catch_copy = '' where salon_id = ${shown.salonId}`,
    ).rejects.toThrow();
    await expect(
      sql`update public.review_generation_showcases set catch_copy = ${"あ".repeat(31)} where salon_id = ${disabled.salonId}`,
    ).rejects.toThrow();
    await expect(
      sql`update public.review_generation_showcases set catch_copy = ${"一行目\n二行目"} where salon_id = ${disabled.salonId}`,
    ).rejects.toThrow();
    // 無効なら写真を外せる。
    await sql`update public.review_generation_showcases set image_path = null where salon_id = ${disabled.salonId}`;
  });

  it("店舗を消すと行も消える", async () => {
    const temp = await createSalon(sql);
    await sql`insert into public.review_generation_showcases (salon_id) values (${temp.salonId})`;
    await sql`delete from public.salons where id = ${temp.salonId}`;
    expect(await sql`select 1 from public.review_generation_showcases where salon_id = ${temp.salonId}`).toHaveLength(0);
  });
});

describe("ai_generation_events の種類", () => {
  it("review_copied・google_opened・cta_clicked は入り、それ以外は入らない", async () => {
    const generationId = randomUUID();
    for (const kind of ["generated", "review_copied", "google_opened", "cta_clicked"]) {
      await sql`insert into public.ai_generation_events (generation_id, salon_id, feature, kind)
                values (${generationId}, ${shown.salonId}, 'review_generation', ${kind})`;
    }
    await expect(
      sql`insert into public.ai_generation_events (generation_id, salon_id, feature, kind)
          values (${generationId}, ${shown.salonId}, 'review_generation', 'posted')`,
    ).rejects.toThrow();
  });
});
