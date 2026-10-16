// 招待ページ・結果ページで、店舗が使える機能に合わせて「どのお知らせが届き得るか」を出し分ける
// (サーバー・クライアントの両方から使う。値は DB の line_flow_topics の結果)。
// 予約通知だけの店舗では、これまでと同じ文言にする。口コミの LINE 通知は、お店の方が通知を開始し、その通知先の
// 口コミ通知を ON にしたときだけ届く(届くのは「新しい口コミが届いた」ことと確認のリンクだけ)。

export interface InviteTopics {
  reservations: boolean;
  reviews: boolean;
}

/** 分からないとき(取得に失敗したとき)は、これまでどおり予約通知として表示する。 */
export const DEFAULT_INVITE_TOPICS: InviteTopics = { reservations: true, reviews: false };

/** 「○○の通知先」の○○。 */
export function inviteTopicLabel(t: InviteTopics): string {
  if (t.reviews && t.reservations) return "予約・口コミのLINE通知";
  if (t.reviews) return "口コミのLINE通知";
  return "予約通知";
}

/** 招待を開いたときに出す、届く内容の説明。 */
export function inviteTopicItems(t: InviteTopics): string[] {
  const items: string[] = [];
  if (t.reservations || !t.reviews) items.push("このお店の予約の情報(予約の日時・メニュー・お客様のお名前など)が、あなたのLINEに届きます。");
  if (t.reviews) {
    items.push("お店の方が口コミの通知をONにすると、このお店に新しいGoogleの口コミが届いたことと、確認のためのリンクがLINEに届きます(口コミの内容・評価・投稿者名は届きません)。");
    items.push("リンクの先の口コミは、このお店のSalonPackにログインできる方だけが開けます。");
  }
  return items;
}

/** 登録が終わったときの説明(1行目)。 */
export function registeredTopicItem(t: InviteTopics): string {
  if (t.reviews && t.reservations) return "お店の予約通知が稼働している間は予約の情報が、口コミの通知がONの間は新しい口コミのお知らせが、このLINEに届きます。";
  if (t.reviews) return "お店の方が口コミの通知をONにしている間、新しい口コミのお知らせがこのLINEに届きます。";
  return "お店の予約通知が稼働している間、予約の情報がこのLINEに届きます。";
}
