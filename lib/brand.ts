import { isReviewsOnly } from "@/lib/appMode";

// Placeholder product identity. The final brand name hasn't been decided yet
// (the codebase's only existing name, "salonpack", is a dev codename, not a
// customer-facing brand). Every screen that shows the product name imports
// SERVICE_NAME/SERVICE_TAGLINE from here instead of hardcoding a string, so
// renaming the product later is a one-line change in this file only.
//
// APP_MODE=reviewsのデプロイ(口コミ365)では別ブランドとして表示する。
export const SERVICE_NAME = isReviewsOnly() ? "口コミ365" : "SalonPack";
export const SERVICE_TAGLINE = isReviewsOnly()
  ? "サロン運営を、もっとシンプルに。"
  : "サロン業務を、もっとシンプルに。";
