# Phase 1（口コミ生成 v2）適用・確認手順

PLAN（docs/plans/reviews-465-plan.md §13）の Phase 1 の、本番への出し方と確認方法。
**migration の本番DBへの適用は、master に取り込んでから運営者が行う**（DB を master より先に変えない）。

## 含まれる変更
| 種類 | 内容 | 本番への影響（REVIEW_PIPELINE 未設定 = v1 のとき） |
|---|---|---|
| アプリ | 口コミ生成 v2（`lib/reviewGeneration/`、`lib/ai/naturalJapanese/`） | なし（`REVIEW_PIPELINE=v2` にするまで使われない） |
| アプリ | `/api/generate-review`：回答を DB のアンケートと照合する。店舗名・業種は DB の値を使う。ログに回答・本文を出さない | v1 の生成結果は変わらない。アンケートと合わない回答は 409（ページの再読み込みを案内） |
| アプリ | レート制限（IP＋店舗で10分に20回、店舗ごとに1日300回） | 0012 の適用前は、DB のエラーとして**制限せずに通す** |
| アプリ | 生成イベントの記録（メタデータのみ）、CTA クリックの記録（`/api/review-events`） | 0012 の適用前は記録に失敗するだけ（お客様への応答には影響しない。ログに警告が出る） |
| アプリ | お客様ページの文言：「口コミの下書きができました」「アンケートの回答をもとにした下書きです。内容を確認して、実際の体験と異なる部分があれば編集してください。」、CTA「内容を確認してGoogleに投稿する」 | 文言が変わる |
| DB（要適用） | `supabase/migrations/0012_review_generation_events.sql`：`ai_generation_events`、`rate_limit_buckets`、`rate_limit_hit()` | 新しいテーブルと関数だけ。既存のテーブルは変更しない |

変更していないもの：seed.sql（選択肢は追加しない）、APP_MODE、`lib/notifications/**`、0009 のテーブル、blog の生成処理、hmail。

## 1. リリースの順番
1. Phase 1 を master に取り込み、本番にデプロイする（`REVIEW_PIPELINE` は未設定のまま = v1）。
2. 0012 を本番 Supabase に適用し、§3 の確認をする。
3. オフライン評価・自動テスト・目視確認・待ち時間・lint の違反率・意味検証の結果を見て、問題なければ Vercel の環境変数に `REVIEW_PIPELINE=v2` を設定して再デプロイする。
4. §4 のクエリで様子を見る。問題があれば `REVIEW_PIPELINE` を外して再デプロイすれば、すぐ v1 に戻る。

## 2. migration 0012 の適用
Supabase ダッシュボードの **SQL Editor** に `0012_review_generation_events.sql` の内容を貼り付けて実行する。
- 何度実行しても同じ結果になる（`if not exists` と `create or replace`）。
- 既存のテーブル・データには触れない。

## 3. 適用後の確認（どれもロールバックするので、データは変わらない）
**確認1：テーブルと関数ができている**（3行とも返れば正常）
```sql
select 'ai_generation_events' as name, to_regclass('public.ai_generation_events') is not null as ok
union all select 'rate_limit_buckets', to_regclass('public.rate_limit_buckets') is not null
union all select 'rate_limit_hit', to_regprocedure('public.rate_limit_hit(text,integer,integer)') is not null;
```

**確認2：上限まで true、超えたら false になる**（`true, true, false` の順になれば正常）
```sql
begin;
set local role service_role;
select public.rate_limit_hit('verify:check', 600, 2) as first,
       public.rate_limit_hit('verify:check', 600, 2) as second,
       public.rate_limit_hit('verify:check', 600, 2) as third;
rollback;
```

**確認3：ブラウザ（anon / authenticated）からは関数もテーブルも使えない**（どちらも `ERROR: 42501`（permission denied）になれば正常。ブロックごとに実行する）
```sql
begin;
set local role anon;
select public.rate_limit_hit('verify:anon', 600, 2);
rollback;
```
```sql
begin;
set local role authenticated;
select count(*) from public.ai_generation_events;
rollback;
```

## 4. 本番での確認（v1 のまま・v2 に切り替えたあと）
イベントは本文を含まないので、次のような集計で様子を見る。
```sql
-- 直近24時間の、パイプライン別の件数・失敗率・待ち時間(p95)
select pipeline,
       count(*) filter (where kind in ('generated', 'regenerated')) as generated,
       count(*) filter (where kind = 'failed') as failed,
       percentile_cont(0.95) within group (order by latency_ms)
         filter (where kind in ('generated', 'regenerated')) as p95_latency_ms
from public.ai_generation_events
where created_at > now() - interval '24 hours'
group by pipeline;

-- 指摘コードの件数(v1 と v2 を比べる)
select pipeline, flag, count(*)
from public.ai_generation_events, unnest(lint_flags) as flag
where created_at > now() - interval '7 days' and kind in ('generated', 'regenerated')
group by pipeline, flag
order by pipeline, count(*) desc;

-- v2 の同期検証の該当率と、意味検証の指摘
select verify_mode, count(*), array_agg(distinct f) filter (where f is not null) as flags
from public.ai_generation_events left join lateral unnest(verify_flags) as f on true
where pipeline = 'v2' and created_at > now() - interval '7 days'
group by verify_mode;
```

## 5. 問題があった場合
- **生成の不具合**：Vercel の `REVIEW_PIPELINE` を外して再デプロイする（v1 に戻る。DB は戻さなくてよい）。
- **0012 を取り消す**（イベントの記録とレート制限が止まるだけで、生成は続く）：
```sql
drop function if exists public.rate_limit_hit(text, integer, integer);
drop table if exists public.rate_limit_buckets;
drop table if exists public.ai_generation_events;
```

## 6. 環境変数（すべて任意）
| 名前 | 既定 | 内容 |
|---|---|---|
| `REVIEW_PIPELINE` | 未設定（v1） | `v2` のときだけ新しい生成を使う |
| `REVIEW_RATE_LIMIT_IP_SALON_PER_10MIN` | 20 | IP＋店舗あたり、10分間の上限 |
| `REVIEW_RATE_LIMIT_SALON_PER_DAY` | 300 | 店舗あたり、1日（UTC の 0 時 = 日本時間 9 時に切り替わる）の上限 |
| `REVIEW_SHADOW_VERIFY_RATE` | 0.2 | 同期検証をしなかった v2 の下書きに、計測用の検証をかける割合 |
| `RATE_LIMIT_HASH_SECRET` | `SUPABASE_SERVICE_ROLE_KEY` | IP をハッシュにするときの鍵 |
| `OPENAI_MODEL_REVIEW_VERIFICATION` | `OPENAI_MODEL` | 意味検証のモデル（オフライン評価で決める） |
