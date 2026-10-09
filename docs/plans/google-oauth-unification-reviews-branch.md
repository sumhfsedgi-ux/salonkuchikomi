# 口コミブランチ(feature/reviews-d1-reply-engine)を共通の Google 連携へ合わせるための変更点

作成: 2026-10-08。口コミブランチは読み取りで調べただけで、変更・取り込みはしていない。
共通の Google 連携は `feature/lavi-notification-cutover`(`lib/google/*`、`supabase/migrations/0021_*`・`0022_*`)。

## 方針の変更

口コミブランチの計画(`docs/plans/google-reviews-inbox-plan.md` §1-4・§6-7(1)・§19)の
「Gmail とは別の OAuth・別のトークン・別の表のままにする。統合しない」「GBP 専用の新しい GCP プロジェクト」は、
**同じアカウントの店舗は1回の連携で Gmail と口コミの権限をまとめて要求する**方針に置き換わる。

## 必要な変更

1. **認証情報と結び付けを分ける**
   - `gbp_connections` は、認証情報(refresh token)と店舗の結び付けを1行に持っている。refresh token は `google_accounts`(Google アカウント単位、`(oauth_client_id, google_sub)` で一意)へ移し、`gbp_connections` には `google_account_id` を持たせる。
   - トークンの AAD(`gbp_refresh:v1:{connectionId}:{salonId}`)とアクセストークンのキャッシュ(接続 id 単位)を、アカウント単位(`google_refresh:v1:{accountId}:{generation}`、`lib/google/tokenBox.ts`)に合わせる。
   - 鍵 `GBP_TOKEN_KEYS`・`GBP_TOKEN_KEY_CURRENT` は `GOOGLE_TOKEN_KEYS`・`GOOGLE_TOKEN_KEY_CURRENT` に統一する(形式は同じ)。
   - `salon_google_bindings`(feature='gbp')を、口コミの「どのアカウントを使うか」の正にする。`gbp_selection_state` に `gbp_locations` の選択状態を反映する。
2. **認可の取り消しの規則**
   - `gbp_disconnect`(0015)は「同じ sub の他の `gbp_connections` が無ければ revoke」としているが、共通のクライアントでは Gmail の許可まで取り消してしまう。Google: "Revocation removes all OAuth 2.0 scopes previously granted to a project…"。
   - 取り消しは `google_unbind_features(…, revoke_if_unreferenced=true)` と、世代と参照ゼロを確かめる待ち行列(`google_begin_revocation` / `google_finish_revocation`)に置き換える。「口コミの利用停止」では取り消さない。
3. **OAuth の開始とコールバック**
   - 常に `prompt=consent` にするのをやめる。`include_granted_scopes=true`、新しい refresh token が無いときは保存済みのトークンを確かめて使い、確かめられなければ1回だけ同意を取り直す(`lib/google/credentialDecision.ts`)。
   - 返ってきた scope に `gmail.readonly` が含まれていても失敗にしない。要求した機能のうち許可されたものだけを結び付ける。
   - 再認証・権限追加は `expected_google_sub` で同じアカウントか確かめる。
   - **id_token の署名を検証する**(口コミブランチは iss/aud/exp/sub だけを確かめ、署名を確かめていない)。`lib/google/idToken.ts` を使う。
   - state は `google_oauth_states`(用途・機能・期待する sub・PKCE・nonce、10分、1回限り)に統一し、`purpose` を実際に使う。
   - 開始・コールバックは `/api/google/oauth/callback` と `app/dashboard/settings/google`(このブランチと同じパス。統合時に競合として明示的に解消する)にまとめる。口コミの店舗選択(`selectGoogleLocationAction`)はこの画面の「届いた口コミ」のカードに組み込む。
4. **権限不足と認証の失敗を分ける**
   - GBP API の `insufficient_scope`(403)は、`google_record_auth_result`(アカウント単位の失敗回数)で数えず、`google_mark_binding_scope(salon, 'gbp', true, …)` で口コミの結び付けにだけ記録する(予約メールの Gmail を「再接続が必要」にしない)。Gmail 側は同じ扱いを `lib/notifications/jobs/pollMailForAllSalons.ts` で実装済み。
   - アカウント全体の再認証にするのは、トークンの更新で `invalid_grant` が続いたときだけ。
5. **本番での有効化**
   - 口コミブランチの「本番では常に unavailable(`resolveGbpBackend`)」と、このブランチの `GOOGLE_REVIEWS_OAUTH_ENABLED`(既定は無効)の両方が、GBP API の利用承認を確認するまで無効のままであること。
6. **LINE の共用(通知先の解除・再登録と世代)**
   - `line_notification_preferences` は `line_connection_id` に結び付いている(外部キーなし)。旧サービスからの移行では、スタッフの hmail salon id をそのまま `line_connections.id` にしている(id を変えない)。統合後もこの id を作り直さないこと。
   - このブランチの 0023 で、通知先の解除は「行を残して `status='not_connected'`・`removed_at`」、再登録は「同じ行を戻して `registration_generation` を +1」になった。口コミ側で合わせる点:
     - `review_notify_list_recipients` は `removed_at is null` の通知先だけを返す(今は解除済みも返す)。
     - 口コミの配信(`review_notification_deliveries`)にも、作成時の `registration_generation` を持たせ、送信の直前に「解除済み・世代違いなら送らない」を確かめる。
     - 解除のとき、送信を一度も始めていない口コミの配信だけを skipped にし、送信を試みた配信は状態を書き換えずに再試行だけを止める(予約通知の `retry_stopped_at` と同じ考え方)。0023 の `line_recipient_stop_review_notifications` は、口コミの表があるときに「設定を OFF」と「未着手の pending を skipped」までを行う(試行済みの停止は口コミ側に列が無いため未対応)。
     - 新しい通知先・再登録した通知先の口コミ通知は OFF のまま(行が無ければ OFF という今の仕様を維持。再登録では 0023 が OFF に戻す)。
7. **migration の番号**
   - 口コミブランチは 0013〜0017。このブランチは 0020(本番適用済み)・0021・0022・0023(本番未適用)。統合時に、口コミブランチ側の追加の修正は 0024 以降にする。
