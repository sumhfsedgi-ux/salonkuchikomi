# Phase 0（安全の土台）適用・確認手順

PLAN（docs/plans/reviews-465-plan.md）の Phase 0 で入れた変更の、本番への適用手順と確認方法。
**migration の本番DBへの適用は、内容を確認したうえで運営者が行う**（コードの変更だけでは本番DBは変わらない）。

## 前提：現在の構成
- **1 Vercel Project / 1 Deployment / 1 codebase**（SalonPack）。口コミ465用の別プロジェクト・別デプロイはない。
- 店舗ごとに使える機能は **`salons.plan`** で決まる。
  - `reviews`（口コミ465）：口コミ・設定のみ
  - `salonpack`：口コミ・ブログ・予約通知など
- 画面上のサービス名・ロゴは、plan に関係なく常に「SalonPack」。「口コミ465」は契約プランの名前で、別ブランドではない。
- `NEXT_PUBLIC_APP_MODE` は、将来別デプロイを作る場合の上限として残しているだけ。本番は未設定（salonpack 扱い＝全機能を提供）のままにする。

## 含まれる変更
| 種類 | 内容 | 本番への影響 |
|---|---|---|
| DB（要適用） | `supabase/migrations/0011_salons_plan_guard.sql`：ブラウザ（anon / authenticated）からの salons への書き込みを制限するトリガー。plan・owner_id・slug などを変更できなくし、新規作成時の plan は 'reviews' に限る | **適用するまで穴は塞がらない** |
| アプリ | `getCurrentSalon` が、店舗が複数あっても毎回同じ（最も古い）店舗を返すようにした。embedding の結果が配列でもオブジェクトでも動く | 1オーナー1店舗の店舗では動作は変わらない |
| アプリ | `createSalonAction`：既に店舗があれば2店舗目を作らず、その店舗を返す | 二重送信などで2店舗目が作られなくなる |
| アプリ | Feature キー `review_replies` / `google_reviews` / `review_notifications` を両モード・両プランに追加 | 対応する画面はまだ無いので、画面上の変化はない |
| アプリ | サービス名を APP_MODE・plan に関係なく常に「SalonPack」にした（reviews モードで別のサービス名に切り替える処理をやめた） | 本番は今も「SalonPack」表示なので、見た目は変わらない |
| アプリ | 新機能用の共通OpenAIクライアント `lib/ai/openai.ts`（まだどこからも使っていない） | なし |
| アプリ | `lib/blog/admin.ts` に `import "server-only"`（クライアントから読み込まれたらビルドが失敗する安全装置） | なし |
| 開発 | vitest とテスト一式（`npm test`）、`.env.example` の追記 | なし |

変更していないもの：`lib/notifications/**`、0009 のテーブル、poll-mail の cron、blog の生成処理、APP_MODE の判定（`lib/appMode.ts` の挙動）、hmail。

## 1. migration 0011 の適用
README のとおり、Supabase ダッシュボードの **SQL Editor** に `0011_salons_plan_guard.sql` の内容を貼り付けて実行する。
- 何度実行しても同じ結果になる（`create or replace function` と `drop trigger if exists` のため）。
- 既存の店舗データは変更しない。

## 2. 適用後の確認（どれもロールバックするので、データは変わらない）
**準備**：確認に使う店舗とオーナーを1つ選ぶ（読み取りのみ）。
```sql
select s.id as salon_id, p.user_id
from public.salons s
join public.profiles p on p.id = s.owner_id
order by s.created_at
limit 1;
```
以下の `<salon_id>` と `<user_id>` を上の結果に置き換え、**ブロックごとに1つずつ**実行する。
拒否される確認（1〜3・5）は、`ERROR: 42501` と次のメッセージになれば正常。
- UPDATE（確認1〜3）：「salons のこの列はクライアントから変更できません」
- INSERT（確認5）：「salons.plan はクライアントから指定できません」

**確認1：オーナーは plan を変更できない**
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<user_id>","role":"authenticated"}', true);
update public.salons set plan = 'salonpack' where id = '<salon_id>';
rollback;
```

**確認2：オーナーは owner_id を変更できない**
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<user_id>","role":"authenticated"}', true);
update public.salons set owner_id = gen_random_uuid() where id = '<salon_id>';
rollback;
```
- owner_id の変更は、0011 の適用前から既存の RLS（0003 の `owner_update` の `with check`）でも 42501 で拒否される（メッセージは「new row violates row-level security policy」）。
- トリガーが効いていることは、**エラーコードではなくメッセージ**（「salons のこの列はクライアントから変更できません」）で確認する。

**確認3：オーナーは slug を変更できない**
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<user_id>","role":"authenticated"}', true);
update public.salons set slug = slug || '-x' where id = '<salon_id>';
rollback;
```
（適用前は `UPDATE 1` になり、変更できてしまう。）

**確認4：オーナーは店舗名などの許可された列を変更できる**（`UPDATE 1` になれば正常）
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<user_id>","role":"authenticated"}', true);
update public.salons set name = name, updated_at = now() where id = '<salon_id>';
rollback;
```

**確認5：オーナーは plan を指定して店舗を作れない**
```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<user_id>","role":"authenticated"}', true);
insert into public.salons (owner_id, name, slug, plan)
select p.id, '確認用', 'verify-' || substr(md5(random()::text), 1, 8), 'salonpack'
from public.profiles p where p.user_id = '<user_id>';
rollback;
```

**確認6：service_role（管理者側）は従来どおり plan を変更できる**（`UPDATE 1` になれば正常）
```sql
begin;
set local role service_role;
update public.salons
set plan = case when plan = 'reviews' then 'salonpack' else 'reviews' end
where id = '<salon_id>';
rollback;
```

## 3. 問題があった場合の取り消し
トリガーと関数を削除すれば、適用前の状態に戻る（データには影響しない）。
```sql
drop trigger if exists salons_client_write_guard on public.salons;
drop function if exists public.salons_client_write_guard();
```

## 4. アプリの確認（デプロイ後）
デプロイは1つなので、plan の違う店舗（アカウント）で確認する。
- plan=reviews の店舗でも、画面のロゴとタブのタイトルが「SalonPack」のままになっている。ナビは「ホーム」「口コミ」だけ。
- 設定画面で、店舗名・業種・店舗の特徴を保存できる（0011 の適用後も）。
- 口コミ画面で、Google口コミ投稿先URLを保存できる（0011 の適用後も）。
- 新しいアカウントで、オンボーディングを最後まで進められる（STEP1 で「戻る」を使っても店舗が2つにならない）。
- plan=salonpack の店舗で、ブログ生成と予約通知の画面が従来どおり動く。

## 5. 未対応・別タスク
- **APP_MODE**：当面は今のまま残す（将来別デプロイを作る場合の上限）。削除・fail-closed 化・未設定時の挙動の変更・画面の出し分けを plan での判定に移すことは、Phase 0 / Phase 1 とは別のタスクで検討する。
  - Vercel で `NEXT_PUBLIC_APP_MODE` を `reviews` にしないこと。デプロイ全体（全店舗）でブログ・予約通知（cron を含む）が止まる。
- **`lib/notifications/admin.ts` への server-only**：予約通知のモジュールには触れない方針のため、今回は入れていない。
