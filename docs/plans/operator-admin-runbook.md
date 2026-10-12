# 運営管理・利用権限(0024)の本番反映(手順)

作成: 2026-10-12。設計は `docs/plans/operator-admin-plan.md`。
**この手順は運営が実施する。** 開発の作業(このブランチ)では、本番 DB・外部設定・デプロイには触れていない。

**全体を通して守ること**
- 0001〜0023 は書き換えない。0024 は新しい migration として適用する。
- 秘密の値・パスワードはチャットやリポジトリに書かない。管理者のパスワードは本人が設定する。
- 管理者はサロンオーナーとは別のアカウントにする。

## 0. 事前の確認(読み取りのみ)
1. SQL Editor で `docs/plans/sql/0024-precheck.sql` を実行し、結果を控える。
   - 3(契約外なのに開始済みの店舗)・4(開いたままの `contract`)は 0 件が想定。1 件以上なら、店舗ごとに扱いを決めてから進める
     (0024 はそれらの店舗に「権限による停止」を記録する。今も送っていないため稼働は変わらないが、SalonPack に戻しても自動では再開しない)。
2. 予約通知の定期処理が正常に動いていること(直近の cron の結果に失敗が無いこと)を確認する。

## 1. 段階 A: 0024 の適用(アプリは今の master のまま)
1. SQL Editor で `supabase/migrations/0024_operator_entitlements.sql` を実行する(何度実行しても同じ結果になるように書いてある。
   途中で失敗した場合は、原因を確かめてからもう一度ファイル全体を実行する)。
2. 確認:
   - `select * from public.feature_catalog;` が reviews / blog / reservation_notifications(すべて available)。
   - `select count(*) from public.salon_entitlement_state;` が店舗数と同じ。
   - `select count(*) from public.salon_feature_overrides;` が 0。
   - 事前確認の 5(`pollable_before`)を、もう一度実行して同じ件数。
   - `select * from public.salon_feature_holds;` が事前確認の 3 の店舗だけ。
3. この段階では、**CLI・SQL での契約変更を控える**。salonpack から外すと「権限による停止」が開くが、今の master のアプリには表示も解除の手段も無い
   (必要になった場合は、段階 B のあとに管理画面で解除する)。

## 2. 段階 B: アプリのデプロイ
1. このブランチを PR にし、レビュー・CI のあとマージしてデプロイする(0024 の適用より先にデプロイしない。
   新しいアプリは予約通知の DB 関数に `p_allowed_plans = null` を渡すため、0024 が無いと予約通知が止まる側に倒れる)。
2. 最初の管理者を登録する:
   1. Supabase の管理画面(Authentication → Users)で、運営専用のアカウントを招待(または作成)する。パスワードは本人が設定する。
   2. そのユーザーの ID(uuid)を確認する(メールアドレスから推測しない)。
   3. `npx tsx scripts/operator-admin.ts grant --user-id=<uuid> --by=<作業者>` で確認し、`--apply` を付けて登録する
      (接続先は `.env.hmail-migration.local` の `DATABASE_URL`。店舗を持つユーザーは登録を断る)。
      SQL Editor で登録する場合: `insert into public.operator_admins (user_id, granted_by, note) values ('<uuid>', '<作業者>', '<メモ>');`
3. 確認:
   - 管理者が通常の `/login` からログインすると `/ops/salons` が開く(店舗登録・初期設定は出ない)。
   - 一般のオーナーで `/ops/salons` を開くと 404。
   - 一覧の「利用可能な機能」が、今の契約と同じ(口コミプラン=口コミ、SalonPack=3機能)。
   - 予約通知を送っている店舗の通知が続いている(cron の結果・`notification_deliveries`)。
   - お客様用ページ・口コミ文章の生成が今まで通り動く。

## 3. 運用
- 契約変更・機能の許可は管理画面で行う(「変更を保存」→ 確認 → 保存)。CLI(`scripts/salon-contract.ts`)は画面が使えないときの代わり。
- 予約通知を利用不可にしたあと再び使えるようにするには、利用許可を保存してから、詳細の「連携と稼働状況」で「停止を解除」する。
  解除しても、受信OFF・お客様の利用停止・運営による停止・旧側の切り替え条件はそのまま。
- 管理者を外すときは `scripts/operator-admin.ts revoke --user-id=<uuid> --by=<作業者> --apply`。
- 全体の提供状態・プランの標準を変えるときは、新しい migration で `feature_catalog`・`plan_feature_rules` を更新する(全店舗の版数が上がり、利用可否と停止がそろう)。
  新しい機能は `coming_soon`・標準に入れない状態で追加する(既存店舗に自動で開放しない)。
- トリガーを止める操作(`session_replication_role = replica` など)はしない(履歴と版数が残らなくなる)。

## 4. 切り戻し
| 状態 | 今の master のアプリに戻せるか |
|---|---|
| 段階 A のあと | アプリは戻す必要が無い(既存の関数の引数は同じで、結果も同じ)。 |
| 段階 B のあと、個別設定 0 件・開いている権限による停止が事前確認の 3 の店舗だけ | 戻せる。 |
| 個別設定・権限による停止がある | **無条件には戻せない。** 下記のとおり、古いアプリでは扱いが変わる。原則は修正版を出す。 |

個別設定・停止があるときに古いアプリへ戻した場合:
- 「個別に利用不可」の店舗: 古いアプリの画面・ブログの生成は使えてしまう(アプリの判定しかないため)。予約通知は DB で止まったままだが、画面には「稼働中」と出る。
- 「権限による停止」: 古い画面には出ず、解除の手段も無い。
- 口コミの停止: お客様用ページ・生成 API は古いアプリでは止まらない。
- 戻すときは、事前に `select * from public.salon_feature_overrides;`・`select * from public.salon_feature_holds where released_at is null;` で対象を一覧にし、
  古いアプリでも同じ結果になる状態(契約の変更・運営による停止など)に移してから戻す。DB(0024)は戻さない。
