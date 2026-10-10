import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import Logo from "@/components/ui/Logo";
import { SERVICE_NAME } from "@/lib/brand";

// プライバシーポリシー(ログイン不要。Google Auth Platform の公開設定に登録する URL)。
// 本文は現在の実装(保存する表・外部への送信・削除の動き)を調べて書いたもの。実装を変えたら本文も見直すこと。
// 運営者の名称・保存期間など、コードで判断できない事項は <Pending> で「確認中」と表示し、決まったら置き換える。

export const metadata: Metadata = {
  title: `プライバシーポリシー | ${SERVICE_NAME}`,
  description: `${SERVICE_NAME}における利用者情報の取扱いについて`,
};

const CONTACT_EMAIL = "salonpack.app@gmail.com";

/** コードで判断できず、運営者の確認が必要な箇所。決まったら本文に置き換える。 */
function Pending({ children }: { children: ReactNode }) {
  return <span className="rounded bg-warning-soft px-1 text-warning">〔確認中:{children}〕</span>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="border-b border-border pb-2 text-base font-semibold text-ink sm:text-lg">{title}</h2>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink sm:text-base">{title}</h3>
      {children}
    </div>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-7 text-ink">{children}</p>;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-7 text-ink marker:text-ink-muted">{children}</ul>;
}

/** 項目名と内容の組(スマートフォンでは縦に並べる)。 */
function Facts({ items }: { items: Array<{ label: string; body: ReactNode }> }) {
  return (
    <dl className="flex flex-col divide-y divide-border rounded-xl border border-border">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-xs font-semibold text-ink-muted sm:w-36 sm:pt-1">{item.label}</dt>
          <dd className="min-w-0 text-sm leading-7 text-ink">{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

const TOC = [
  { id: "scope", title: "1. 対象となる方とサービス" },
  { id: "collect", title: "2. 取得する情報と利用目的" },
  { id: "external", title: "3. 外部サービスへの送信" },
  { id: "google", title: "4. Google から取得する情報の取扱い" },
  { id: "retention", title: "5. 保存期間と削除の基準" },
  { id: "delete", title: "6. 連携の解除とデータの削除" },
  { id: "security", title: "7. 安全管理" },
  { id: "cookie", title: "8. Cookie" },
  { id: "rights", title: "9. 開示・訂正・利用停止・削除のご請求" },
  { id: "contact", title: "10. お問い合わせ窓口" },
  { id: "changes", title: "11. このポリシーの変更" },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-ivory">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-4">
          <Link href="/" aria-label={`${SERVICE_NAME} のトップへ`}>
            <Logo />
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-12">
        <article className="rounded-2xl border border-border bg-white px-5 py-8 sm:px-10 sm:py-10">
          <h1 className="text-xl font-semibold text-ink sm:text-2xl">プライバシーポリシー</h1>
          <p className="mt-2 text-xs text-ink-muted">
            制定日: <Pending>制定日</Pending> / 最終改定日: <Pending>最終改定日</Pending>
          </p>

          <div className="mt-6 flex flex-col gap-4">
            <P>
              <Pending>運営者の正式名称</Pending>(以下「運営者」)は、サロン向けのサービス「{SERVICE_NAME}」(以下「本サービス」)で取り扱う情報について、次のとおりプライバシーポリシーを定めます。
            </P>
            <P>
              本サービスは、店舗が使う機能(口コミ文章の作成、ブログ作成、予約通知など)を、店舗ごとの契約と設定に応じて提供します。このポリシーでは、機能ごとに、取得する情報・利用目的・保存・外部への送信を説明します。
            </P>
          </div>

          <nav aria-label="目次" className="mt-8 rounded-xl bg-ivory px-4 py-4 sm:px-6">
            <p className="text-xs font-semibold text-ink-muted">目次</p>
            <ol className="mt-2 flex flex-col gap-1.5 text-sm">
              {TOC.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`} className="text-sage-dark underline-offset-4 hover:underline">
                    {item.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="mt-10 flex flex-col gap-12">
            <Section id="scope" title="1. 対象となる方とサービス">
              <P>このポリシーは、本サービスに関わる次の方の情報に適用します。</P>
              <List>
                <li>本サービスを利用する店舗のオーナー・担当者(以下「店舗」)</li>
                <li>店舗のお客様のうち、店舗のアンケートページで回答した方</li>
                <li>店舗が受け取る予約メールに記載された予約者</li>
                <li>店舗が予約通知の通知先として招待・登録したスタッフなど(以下「通知先」)</li>
              </List>
              <P>
                Google、LINE、Hot Pepper Beauty、SALON BOARD など外部のサービスでの情報の取扱いは、それぞれの事業者のプライバシーポリシー・規約に従います。
              </P>
            </Section>

            <Section id="collect" title="2. 取得する情報と利用目的">
              <SubSection title="2-1. アカウントと店舗の情報">
                <Facts
                  items={[
                    {
                      label: "取得する情報",
                      body: "ログイン用のメールアドレスとパスワード、表示名、店舗名・店舗の説明・業種、Google の口コミ投稿ページの URL、アンケートページの URL に使う文字列、契約の種類、利用する機能の選択、設定を変更した担当者と日時",
                    },
                    {
                      label: "利用目的",
                      body: "ログインと本人確認、契約と設定に応じた機能の提供、パスワードの再設定などのご案内、お問い合わせへの対応、不正な利用の防止",
                    },
                    {
                      label: "補足",
                      body: "パスワードは認証の仕組み(Supabase の認証機能)で管理し、本サービスのデータベースの表には保存しません。",
                    },
                  ]}
                />
              </SubSection>

              <SubSection title="2-2. アンケートと口コミ文章の作成">
                <Facts
                  items={[
                    {
                      label: "取得する情報",
                      body: "店舗のお客様がアンケートページで選んだ回答・入力した文章、文章案を作り直すときの前回の文章案",
                    },
                    {
                      label: "利用目的",
                      body: "お客様が Google に口コミを投稿するときの文章案の作成",
                    },
                    {
                      label: "AI の利用",
                      body: (
                        <>
                          文章案を作るため、アンケートの回答と店舗の業種(作成方式によっては店舗名も)を OpenAI の API に送信します。お客様の自由記述に個人を特定できる内容が書かれた場合は、その内容も送信されます。
                        </>
                      ),
                    },
                    {
                      label: "保存するもの",
                      body: (
                        <>
                          現在の実装では、アンケートの回答と作成した文章案を、本サービスのデータベースには保存しません。保存するのは、作成の記録(日時、店舗、処理時間、使用した AI のモデル名と処理量、エラーの種類、口コミ投稿ボタンが押されたこと)です。
                          短時間の大量の利用を防ぐため、アクセス元の IP アドレスを元に戻せない形(ハッシュ値)に変換した値を、一時的に記録します。
                        </>
                      ),
                    },
                    {
                      label: "Google への投稿",
                      body: "文章案は、お客様ご自身がコピーして Google に投稿します。本サービスが Google に口コミを投稿することはありません。",
                    },
                  ]}
                />
              </SubSection>

              <SubSection title="2-3. ブログ作成">
                <Facts
                  items={[
                    {
                      label: "取得する情報",
                      body: "店舗が入力したブログの設定(主なメニュー、得意分野、お客様層、よくあるお悩み、店舗の特徴、口調、絵文字の量、避けたい表現)、記事のテーマ、作成した記事、文体の分析結果。店舗が Hot Pepper Beauty のブログの URL を指定した場合は、その公開ページから取り込んだ過去記事(タイトル、本文、投稿者名、URL)",
                    },
                    {
                      label: "利用目的",
                      body: "店舗のブログ記事の下書きの作成、店舗の文体に近づけるための分析、同じような記事が続かないようにするための参照",
                    },
                    {
                      label: "AI の利用",
                      body: "記事の作成と文体の分析のため、店舗の情報、ブログの設定、テーマ、直近の記事の要約、取り込んだ過去記事の本文を OpenAI の API に送信します。",
                    },
                    {
                      label: "外部からの取得",
                      body: "過去記事の取り込みでは、店舗が指定した Hot Pepper Beauty の公開ページを、本サービスのサーバーから取得します。",
                    },
                  ]}
                />
              </SubSection>

              <SubSection title="2-4. 予約メールの確認と LINE への予約通知">
                <P>
                  店舗が予約通知を使う場合、店舗が連携した Gmail から Hot Pepper Beauty(SALON BOARD)の予約メールを確認し、予約・キャンセルの内容を、店舗が登録した LINE の通知先に送ります。
                </P>
                <Facts
                  items={[
                    {
                      label: "Google 連携で取得する情報",
                      body: "Google アカウントの識別子、メールアドレス、店舗が許可した権限の範囲、Gmail を読み取るための認証情報(リフレッシュトークン。暗号化して保存)",
                    },
                    {
                      label: "Gmail から取得する情報",
                      body: (
                        <>
                          SALON BOARD の送信元(yoyaku_system@salonboard.com)から届いたメールだけを検索して読み取ります。読み取ったメールから、予約・キャンセルなどの種類、予約日時、予約者名、メニューを取り出します。ほかの送信元のメールを検索・読み取りすることはありません。
                        </>
                      ),
                    },
                    {
                      label: "保存するもの",
                      body: "メールの識別子、受信日時、種類の判定結果、確認の進み具合、LINE に送る文面(取り出した予約日時・予約者名・メニュー)とその送信結果。現在の実装では、メールの件名・本文そのものは本サービスのデータベースには保存しません。",
                    },
                    {
                      label: "利用目的",
                      body: "予約・キャンセルを店舗の通知先に知らせること、同じ予約を二重に通知しないこと、送信できなかった通知の再送と状況の確認、店舗の管理画面での通知履歴の表示",
                    },
                    {
                      label: "LINE への送信",
                      body: "予約日時・予約者名・メニューを含む通知文を、LINEヤフー株式会社の Messaging API を通じて、店舗が登録した通知先の LINE に送信します。送信先は店舗が招待・登録した通知先だけです。",
                    },
                    {
                      label: "AI の利用",
                      body: "Gmail から取得した情報は、OpenAI などの AI サービスには送信しません(アンケート・ブログでの AI の利用とは別です)。",
                    },
                  ]}
                />
                <P>
                  運営者が以前から提供している予約通知サービスから本サービスへ切り替える店舗では、切り替えの際に、以前のサービスで登録されていた通知先(LINE のユーザー識別子、表示名、通知の設定)と、二重通知を防ぐための送信記録を引き継ぎます。
                </P>
              </SubSection>

              <SubSection title="2-5. LINE の通知先の招待と管理">
                <Facts
                  items={[
                    {
                      label: "取得する情報",
                      body: "店舗が入力した通知先の表示名、招待の有効期限と利用状況、LINE ログインで受け取る LINE のユーザー識別子、通知先ごとの通知の設定(新規予約・キャンセル)、登録・解除の日時",
                    },
                    {
                      label: "LINE ログインで確認すること",
                      body: "本人の LINE アカウントであること、本サービスの LINE 公式アカウントと友だちになっていること。LINE の表示名やプロフィール画像は保存しません。",
                    },
                    {
                      label: "利用目的",
                      body: "通知先の本人確認と登録、予約通知・テスト通知の送信、店舗による通知先の管理",
                    },
                    {
                      label: "補足",
                      body: "招待のリンク・連携を始めたブラウザの確認に使う値は、元に戻せない形(ハッシュ値)にして保存します。",
                    },
                  ]}
                />
              </SubSection>

              <SubSection title="2-6. Google の口コミの取得・返信(未提供)">
                <P>
                  Google ビジネスプロフィールに届いた口コミの取得や、口コミへの返信の機能は、現在は提供していません(画面では「準備中」と表示しています)。現在、本サービスは Google ビジネスプロフィールへのアクセスの許可を求めていません。提供を始める前に、このポリシーを改定してお知らせします。
                </P>
              </SubSection>

              <SubSection title="2-7. ご利用時に自動で記録される情報">
                <P>
                  ログインの状態を保つための Cookie などを使います(8. Cookie)。本サービスのホスティング・データベースの事業者のしくみにより、アクセスの日時、IP アドレス、ブラウザの種類などがアクセスログとして記録されることがあります。本サービスは、広告の配信やアクセス解析のためのツールを使っていません。
                </P>
              </SubSection>
            </Section>

            <Section id="external" title="3. 外部サービスへの送信">
              <P>本サービスは、次の外部サービスを利用し、それぞれに必要な情報を送信します。情報を販売することはありません。広告の目的で外部に提供することもありません。</P>
              <Facts
                items={[
                  {
                    label: "Supabase",
                    body: (
                      <>
                        データベースとログインの仕組み。本サービスで保存する情報は、すべてここに保存します。保存場所: <Pending>データベースの所在地(インド・ムンバイのリージョンと認識。要確認)</Pending>
                      </>
                    ),
                  },
                  { label: "Vercel", body: "本サービスのホスティング(画面・処理の実行)。本サービスとのすべての通信がここを通ります。" },
                  {
                    label: "OpenAI",
                    body: "アンケートの回答と店舗の業種など(2-2)、ブログの設定・テーマ・過去記事など(2-3)を、文章を作るために送信します。Gmail から取得した情報は送信しません。",
                  },
                  {
                    label: "Google",
                    body: "Google アカウントでの連携(許可の画面・認証)、Gmail の予約メールの読み取り、連携を解除したときの許可の取り消しの依頼",
                  },
                  {
                    label: "LINEヤフー",
                    body: "LINE ログイン(通知先の本人確認と友だち状態の確認)と、Messaging API による予約通知・テスト通知の送信(送信先の LINE のユーザー識別子と通知文)",
                  },
                  {
                    label: "Hot Pepper Beauty",
                    body: "ブログの過去記事の取り込みで、店舗が指定した公開ページを取得します(取得のための通常の通信だけで、利用者の情報は送りません)。",
                  },
                ]}
              />
              <P>
                OpenAI など各社での情報の取扱い(保存期間・利用の範囲など)は、各社の規約とポリシーに従います。外国にある事業者への送信・外国での保管について、個人情報の保護に関する法律に基づいて必要な情報は <Pending>外国にある第三者への提供・外国での保管に関する記載</Pending>。
              </P>
              <P>上記のほか、法令に基づく場合などを除き、ご本人の同意なく個人情報を第三者に提供しません。</P>
            </Section>

            <Section id="google" title="4. Google から取得する情報の取扱い">
              <P>
                本サービスが Google API を通じて取得する情報は、Gmail の読み取りの許可(gmail.readonly)で取得する予約メールと、Google アカウントの識別子・メールアドレスです。
              </P>
              <p lang="en" className="text-sm leading-7 text-ink">
                {SERVICE_NAME}&apos;s use and transfer to any other app of information received from Google APIs will adhere to{" "}
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  className="text-sage-dark underline underline-offset-4"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Google API Services User Data Policy
                </a>
                , including the Limited Use requirements.
              </p>
              <P>
                本サービスによる Google API から取得した情報の利用と、他のアプリへの移転は、Limited Use(利用の制限)の要件を含む Google API Services User Data Policy に従います。具体的には、次のとおり取り扱います。
              </P>
              <List>
                <li>Gmail から取得した情報は、店舗が使う予約通知の機能(予約メールの確認、店舗が登録した通知先への LINE での通知、通知履歴の表示)の提供と改善のためだけに使います。</li>
                <li>通知のための LINE への送信を除き、Gmail から取得した情報を第三者に移転しません。ただし、セキュリティの確保、法令の遵守、事業の合併・買収などで必要な場合を除きます。</li>
                <li>Gmail から取得した情報を、広告の配信・ターゲティングに使いません。販売もしません。</li>
                <li>Gmail から取得した情報を、AI モデルの開発・改善・学習に使いません。また、Gmail から取得した情報を AI サービスに送信していません。</li>
                <li>運営者の担当者が Gmail から取得した情報を閲覧するのは、店舗の同意がある場合、セキュリティ上の調査に必要な場合、法令の遵守に必要な場合、または集計・匿名化したうえで運営に使う場合に限ります。</li>
              </List>
            </Section>

            <Section id="retention" title="5. 保存期間と削除の基準">
              <P>現在の実装で、期限を設けているものは次のとおりです。</P>
              <List>
                <li>口コミ文章の作成の利用回数の記録(IP アドレスのハッシュ値を含む): 2日より古いものを順次削除します(削除の時期は一定ではありません)。</li>
                <li>LINE の通知先の招待: 発行から24時間で使えなくなります。</li>
                <li>Google・LINE との連携の途中で使う一時的な情報: 10分程度で使えなくなります。</li>
              </List>
              <P>
                上記以外の情報(アカウント・店舗の情報、ブログの記事と設定、Google 連携の情報、予約通知の記録、通知先の情報など)は、現在、期間を定めて自動で削除する仕組みはなく、アカウントのご利用中は保存します。それぞれの保存期間と、ご解約後の扱いは <Pending>保存期間・解約後の削除の基準</Pending>。
              </P>
            </Section>

            <Section id="delete" title="6. 連携の解除とデータの削除">
              <P>「連携の解除」は、それ以後の取得や送信を止める操作です。すでに保存した情報の削除とは異なります。</P>
              <SubSection title="Google 連携をすべて解除する">
                <P>
                  管理画面の「Google連携」の「Google連携をすべて解除」で解除できます。この店舗と Google アカウントの結び付けを外し、Gmail の読み取りを止めます。その Google アカウントがほかの店舗・機能で使われていなければ、保存している認証情報を消去し、Google に許可の取り消しを依頼します。
                </P>
                <P>
                  ただし、Google アカウントの識別子・メールアドレス、連携の履歴、すでに保存した予約通知の記録は、解除だけでは削除されません。許可の取り消しの処理のため、暗号化した認証情報を別に保持する場合があります。Google アカウントの設定(<a href="https://myaccount.google.com/connections" className="break-all text-sage-dark underline underline-offset-4" target="_blank" rel="noopener noreferrer">https://myaccount.google.com/connections</a>)からも、本サービスへの許可を取り消せます。
                </P>
              </SubSection>
              <SubSection title="機能の利用をやめる">
                <P>「利用する機能」で機能をオフにしたり、「Google連携」で「(機能名)の利用を停止する」を押したりすると、その機能での利用を止めます。この操作では、Google での許可は取り消しません(許可を取り消すときは、上の「すべて解除」を使います)。</P>
              </SubSection>
              <SubSection title="LINE の通知先を解除する">
                <P>
                  管理画面の「予約通知」で「通知先から解除」を押すと、その通知先への送信を止めます。同じ通知先をもう一度登録できるように、LINE のユーザー識別子と登録の記録は残ります。通知先の方は、LINE で本サービスの公式アカウントをブロックすることでも、受信を止められます。
                </P>
              </SubSection>
              <SubSection title="ブログの記事を削除する">
                <P>作成した記事は、管理画面のブログの履歴から1件ずつ削除できます。取り込んだ過去記事・文体の分析結果は、現在、画面からは削除できません。削除をご希望の場合はお問い合わせください。</P>
              </SubSection>
              <SubSection title="データの削除・アカウントの削除をご希望の場合">
                <P>
                  画面から削除できない情報の削除や、アカウントの削除は、10. お問い合わせ窓口までご連絡ください。ご本人の確認のうえで対応します。削除の対象となる範囲と、対応にかかる期間は <Pending>削除依頼の対応範囲・期間・バックアップの扱い</Pending>。
                </P>
              </SubSection>
            </Section>

            <Section id="security" title="7. 安全管理">
              <P>運営者は、取り扱う情報の漏えい・滅失・毀損を防ぐため、次の措置を講じます。</P>
              <List>
                <li>本サービスとの通信を暗号化(HTTPS)します。</li>
                <li>Google の認証情報と、連携の途中で使う確認用の値は、AES-256-GCM で暗号化して保存します。</li>
                <li>招待のリンク、ブラウザの確認用の値などは、元に戻せない形(ハッシュ値)で保存します。</li>
                <li>データベースの表は、ログインした店舗が自分の店舗の情報だけを扱えるように、またはサーバーの処理だけが扱えるように、アクセスを制限します。</li>
                <li>アンケートの回答、作成した文章、予約メールの内容を、処理のログに出力しないようにしています。</li>
                <li>
                  組織的・人的な安全管理措置: <Pending>担当者の範囲、アクセス権限の管理、従業者への教育などの体制</Pending>
                </li>
              </List>
            </Section>

            <Section id="cookie" title="8. Cookie">
              <P>本サービスは、次の目的で Cookie を使います。広告やアクセス解析のための Cookie は使っていません。</P>
              <List>
                <li>ログインの状態を保つため(Supabase の認証の Cookie)</li>
                <li>LINE の通知先の登録で、連携を始めたブラウザと連携の結果を結び付けるため(最長24時間)</li>
              </List>
            </Section>

            <Section id="rights" title="9. 開示・訂正・利用停止・削除のご請求">
              <P>
                ご本人から、保有する個人情報の開示、訂正・追加・削除、利用の停止・消去、第三者への提供の停止のご請求があった場合は、ご本人であることを確認のうえ、法令に従って対応します。ご請求は、10. お問い合わせ窓口までご連絡ください。手続きの詳細は <Pending>請求の手続き・手数料の有無</Pending>。
              </P>
              <P>
                店舗のお客様・予約者・通知先の方の情報は、店舗が本サービスを使って取り扱っている情報です。内容によっては、店舗と連携して対応します。
              </P>
            </Section>

            <Section id="contact" title="10. お問い合わせ窓口">
              <Facts
                items={[
                  { label: "運営者", body: <Pending>運営者の正式名称</Pending> },
                  { label: "所在地", body: <Pending>所在地</Pending> },
                  { label: "代表者", body: <Pending>代表者の氏名(法人の場合)</Pending> },
                  {
                    label: "メール",
                    body: (
                      <a href={`mailto:${CONTACT_EMAIL}`} className="break-all text-sage-dark underline underline-offset-4">
                        {CONTACT_EMAIL}
                      </a>
                    ),
                  },
                ]}
              />
            </Section>

            <Section id="changes" title="11. このポリシーの変更">
              <P>
                法令の改正、機能の追加・変更などに応じて、このポリシーを変更することがあります。変更した場合は、このページに掲載し、最終改定日を更新します。重要な変更は <Pending>重要な変更の通知方法</Pending>。
              </P>
            </Section>
          </div>
        </article>

        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="text-ink-muted transition hover:text-sage-dark">
            ログイン画面へ戻る
          </Link>
        </p>
      </main>
    </div>
  );
}
