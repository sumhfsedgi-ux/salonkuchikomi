/**
 * 運営管理(/ops)の管理者の登録・取り消しと、確認(運営専用)。管理者の追加・削除の画面は作らない。
 * 管理者はメールアドレスではなく、Supabase Auth のユーザー ID(uuid)で登録する(メールアドレスから推測しない)。
 * ユーザーは先に Supabase の管理画面で作成・招待しておく(パスワードは本人が設定する。ここでは扱わない)。
 * サロンオーナーとは別のアカウントで運用する(店舗を持つユーザーは登録を断る)。
 *
 *   npx tsx scripts/operator-admin.ts list
 *   npx tsx scripts/operator-admin.ts grant  --user-id=<uuid> --by=<作業者> [--note=<メモ>] [--apply]
 *   npx tsx scripts/operator-admin.ts revoke --user-id=<uuid> --by=<作業者> [--apply]
 *
 * 既定は確認だけ。接続先は .env.hmail-migration.local の DATABASE_URL(値は表示しない)。
 */
import { getArg, hasFlag, operatorName, requireArg, runCli } from "./notifications-ops/connect";

const command = process.argv[2];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

void runCli(async (sql) => {
  if (command === "list") {
    const rows = await sql<{ user_id: string; email: string | null; granted_at: Date; granted_by: string; revoked_at: Date | null }[]>`
      select a.user_id, u.email, a.granted_at, a.granted_by, a.revoked_at
        from public.operator_admins a left join auth.users u on u.id = a.user_id
       order by a.granted_at`;
    for (const r of rows) {
      console.log(`${r.user_id} ${r.email ?? "-"} 登録 ${r.granted_at.toISOString()} (${r.granted_by})${r.revoked_at ? ` 取り消し ${r.revoked_at.toISOString()}` : ""}`);
    }
    if (rows.length === 0) console.log("管理者は登録されていません。");
    return;
  }
  if (command !== "grant" && command !== "revoke") throw new Error("list・grant・revoke のどれかを指定してください。");

  const userId = requireArg("user-id");
  if (!UUID.test(userId)) throw new Error("--user-id は Supabase Auth のユーザー ID(uuid)で指定してください。");
  const by = operatorName();
  const [user] = await sql<{ id: string; email: string | null }[]>`select id, email from auth.users where id = ${userId}`;
  if (!user) throw new Error("そのユーザーは Supabase Auth にいません。先に管理画面で作成・招待してください。");
  const [current] = await sql<{ revoked_at: Date | null }[]>`select revoked_at from public.operator_admins where user_id = ${userId}`;
  console.log(`ユーザー ${user.id} ${user.email ?? "-"} 現在: ${!current ? "未登録" : current.revoked_at ? "取り消し済み" : "管理者"}`);

  if (command === "grant") {
    const [salon] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.salons s join public.profiles p on p.id = s.owner_id where p.user_id = ${userId}`;
    if (salon.n > 0) throw new Error("このユーザーは店舗を持っています。管理者はサロンオーナーとは別のアカウントにしてください。");
    if (current && !current.revoked_at) {
      console.log("変更はありません。");
      return;
    }
    const note = (getArg("note") ?? "").slice(0, 300) || null;
    console.log("変更: 管理者として登録します。");
    if (!hasFlag("apply")) {
      console.log("確認だけです。--apply で登録します。");
      return;
    }
    await sql`
      insert into public.operator_admins (user_id, granted_by, note) values (${userId}, ${by}, ${note})
      on conflict (user_id) do update set granted_at = now(), granted_by = excluded.granted_by, note = excluded.note,
        revoked_at = null, revoked_by = null`;
    console.log("登録しました。このユーザーが通常のログイン画面からログインすると、運営管理(/ops/salons)が開きます。");
    return;
  }

  if (!current || current.revoked_at) {
    console.log("変更はありません。");
    return;
  }
  console.log("変更: 管理者の登録を取り消します(履歴として行は残します)。");
  if (!hasFlag("apply")) {
    console.log("確認だけです。--apply で取り消します。");
    return;
  }
  await sql`update public.operator_admins set revoked_at = now(), revoked_by = ${by} where user_id = ${userId} and revoked_at is null`;
  console.log("取り消しました。次の操作から運営管理は使えません。");
});
