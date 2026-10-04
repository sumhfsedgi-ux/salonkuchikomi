// Product identity. Every screen that shows the product name imports
// SERVICE_NAME/SERVICE_TAGLINE from here instead of hardcoding a string, so
// renaming the product later is a one-line change in this file only.
//
// 画面上のサービス名は、店舗の契約プラン(salons.plan)に関係なく常に「SalonPack」。
// 「口コミ465」は口コミ機能だけを使える契約プラン(plan=reviews)の名前で、
// 画面のブランドを切り替えるものではない。APP_MODE でも切り替えない
// (どの機能を使えるかは lib/access/plan.ts が salons.plan で判定する)。
export const SERVICE_NAME = "SalonPack";
export const SERVICE_TAGLINE = "サロン業務を、もっとシンプルに。";
