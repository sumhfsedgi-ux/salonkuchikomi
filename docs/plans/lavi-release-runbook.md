# 予約通知の本番準備・実機確認・Lavi の切り替え(手順)

作成: 2026-10-09。branch: `feature/lavi-notification-cutover`。詳しい理由・切り戻しは `docs/plans/lavi-notification-cutover-plan.md`。

**全体を通して守ること**
- 旧サービス(hmail)は動かしたまま。止めるのは段階4の②で、Lavi のスタッフ3人分の行だけ(ayana は旧側で継続)。
- 既存の LINE 公式アカウント(Messaging API チャネル)の Webhook URL・チャネルシークレット・アクセストークンは、**変更・再発行しない**。
- 秘密の値はチャットに貼らない。お客様のメールアドレスはリポジトリに書かない(運営の対応表から CLI の引数で渡す)。
- 実機確認で使う LINE は運営自身のものだけ。お客様・スタッフの LINE には送らない。

## 実装範囲(この段階で確定。追加の改修はしない)

| 含む | 状態 |
|---|---|
| 共通の Google 連携(Gmail の読み取り)・機能の選択(0021) | 本番では Google の条件の確認(段階3)まで未完了 |
| 予約通知の運用状態・旧側との切り替え・対応表・運用 CLI・実行時間の管理(0022) | Lavi の切り替えで使う |
| LINE 通知先の招待とスタッフ本人の LINE ログイン・解除と再登録の世代(0023) | LINE ログインチャネルの設定後に有効 |
| お客様向けの表示・切り替え待ちの間の変更の制限 | — |
| LINE の実送信は本番だけ(`lib/notifications/line/sendPolicy.ts`) | 検証モードで宛先を限定できる |

含まないもの: 届いた口コミ(口コミブランチは未統合。`GOOGLE_REVIEWS_OAUTH_ENABLED` は設定しない)、ayana の切り替え、hmail 全体の停止。
既知事項(初回の cookie の競合・ブラウザ確認の単発のタイムアウト)は計画書 §10.1。

## 1. 本番反映前の準備

1. **コードを確定する**: このブランチを commit し、PR を作る(まだ master にマージしない)。
2. **読み取りだけの事前確認**(計画書 §10「事前確認」): 本番の `public.mail_connections` が0件 / service_role が `hmail.mail_connections` を読める / 運用 CLI の接続で hmail の表を読める / hmail の cron の間隔。
3. **LINE ログインチャネルを作る**(LINE Developers): hmail の公式アカウントの Messaging API チャネルと**同じプロバイダー**に作成する。
   - コールバック URL: `https://<本番ドメイン>/api/line/login/callback`
   - 「Linked LINE Official Account」に公式アカウントを設定し、チャネルを公開する。
   - Messaging API チャネル側の設定には触れない。
4. **運営への問い合わせ先を決める**(https: / mailto: / tel:)。決まらなければ、画面に問い合わせのリンクが出ないまま進むことになる(Lavi の開始までに決める)。
5. **Vercel の環境変数(Production)を設定する**:
   - 新しく: `NEXT_PUBLIC_APP_URL`、`GOOGLE_TOKEN_KEYS`・`GOOGLE_TOKEN_KEY_CURRENT`(LINE ログインの検証値の暗号化にも使う)、`NOTIFICATIONS_CRON_SECRET`、`LINE_LOGIN_CHANNEL_ID`・`LINE_LOGIN_CHANNEL_SECRET`、`LINE_RECIPIENT_INVITES_ENABLED=1`、`NEXT_PUBLIC_SUPPORT_CONTACT_URL`・`_LABEL`(決まっていれば)
   - **実機確認のあいだは送信を止めておく**: `LINE_REAL_SEND_VERIFY=1`、`LINE_REAL_SEND_VERIFY_DESTINATIONS` は空。→ 本番でも LINE へは1通も送らない。
   - 既存の値をそのまま使う: `LINE_CHANNEL_ACCESS_TOKEN`(再発行しない)
   - 設定しない: `SALONPACK_VERIFY_MODE`・`GOOGLE_OAUTH_SIMULATED`・`LINE_LOGIN_SIMULATED`・`GOOGLE_REVIEWS_OAUTH_ENABLED`
   - `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` は段階3で設定する(先に入れてもよい)。
6. **本番 DB に適用する**(SQL Editor): `0021` → `0022` → `0023` の順。hmail の表は変えない。
7. **master にマージしてデプロイする**。確認: ログインできる / `/dashboard/notifications` が表示される / `POST /api/cron/notifications/poll-mail` が秘密値なしで 401。

## 2. 実機確認(運営自身の LINE だけ)

運営の検証用の店舗を使う(予約通知を含む契約: `scripts/salon-contract.ts set-plan … --plan=salonpack`。「利用する機能」で予約通知を選ぶ)。この店舗の予約通知は開始しない。

**2-A. LINE ログインと通知先の登録**(送信は一切しない状態で行う)
1. PC で検証用の店舗の「予約通知」→「通知先を追加」→ 表示名 →「招待を作成」。
2. 招待のリンクを運営自身のスマートフォンで開く(LINE のトークから開く = LINE 内のブラウザ、と QR の両方を試す)。
3. 店舗名を確かめて「LINEで連携する」→ LINE の同意 → 友だち追加 → 「…の予約通知の通知先に追加されました」。
4. PC の一覧に「連携済み」で出る。テスト通知の欄が「この環境では、LINEへは実際には送信しません」になっている。
5. 公式アカウントにはトークを送らない(hmail の Webhook が応答するため)。
6. 運営自身の LINE のユーザー ID を読む(読み取りだけ): `select destination_id from public.line_connections where salon_id = '<検証用の店舗の id>' and removed_at is null;`

**2-B. 指定宛先へのテスト送信**
1. Vercel の `LINE_REAL_SEND_VERIFY_DESTINATIONS` に 2-A の6のユーザー ID だけを設定し、再デプロイする。
2. 検証用の店舗の「予約通知」で、案内が「検証モード: 指定した検証用の宛先(1人)にだけ…」であることを確かめてから押す → 確認で「送信する」。
3. 運営自身の LINE に「予約通知の設定が完了しました」が届く。画面は「検証用の宛先にだけ送信しました…」。
4. `LINE_REAL_SEND_VERIFY_DESTINATIONS` を空に戻して再デプロイする(段階4の④の直前まで、再び送信しない状態にする)。

## 3. Google 接続の条件 【未完了】

次がすべて確認できるまで、この段階は未完了のまま残し、段階4の①(お客様への再接続の依頼)に進まない。

1. 共通の OAuth クライアントを作る Google Cloud プロジェクト(口コミの GBP API の申請先と一致させる)。
2. 公開ステータスを「本番」にする(「テスト」のままだと refresh token が7日で失効する)。
3. `gmail.readonly`(制限付きスコープ)の審査・セキュリティ評価が必要か、審査前に使える範囲(ユーザー数・確認画面)を、Google の公式の記載で確かめる。
4. リダイレクト URI `https://<本番ドメイン>/api/google/oauth/callback` を登録し、`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` を設定して再デプロイ。
5. 運営自身の Gmail で検証用の店舗から連携し、予約通知のカードが「許可済み」になる。数日後も再接続を求められない。

## 4. Lavi の切り替え(計画書 §5 の ⓪〜⑤)

1. **⓪ 準備**: Lavi の新側の店舗を確かめる → `map`(対応表。3人)→ 静的移行(切り替え待ち)。ayana の行は入れない。
2. **① お客様の再接続**: Lavi のお客様に、予約メールが届く Gmail での連携をお願いする。`list --awaiting` で「接続アカウントと一致」を確かめる。旧側は通知を続けている。
3. **② 旧側の停止**: hmail の cron を一時停止 → `stop-legacy`(Lavi の3人分だけ)→ cron を再開 → `confirm-cutover`。
4. **③ 照合**: `reconcile` → 確認待ちを `resolve` → `accept-reconciliation`(未解決ゼロ)。
5. **④ の直前**:
   - Vercel の `LINE_REAL_SEND_VERIFY`・`LINE_REAL_SEND_VERIFY_DESTINATIONS` を削除して再デプロイ。検証用の店舗の案内が「登録済みの通知先(◯人)のLINEに、実際にテストメッセージを送ります。」になっていることを確かめる(押さない)。
   - cron-job.org に SalonPack の `POST /api/cron/notifications/poll-mail`(`Authorization: Bearer <NOTIFICATIONS_CRON_SECRET>`)のジョブを作る。応答の `lineSendMode` が `live`。段階3で `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` を設定する前にこのジョブを動かすと、本処理が 500 になる(画面・LINE ログインは Google の設定なしでも動く)。
6. **④ 開始**: `activate --salon-id=<Lavi>`(確認だけ → `--apply`)。
7. **⑤ 確認**: 実際の新規予約・キャンセルが Lavi のスタッフに1回ずつ届く(`notification_deliveries` が sent・`line_request_id` あり)。ayana は旧側で届き続けている。

問題があれば計画書 §6(切り戻し)。ayana の切り替えは後日、同じ段階4を別に行う。
