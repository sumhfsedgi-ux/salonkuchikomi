// 運営への問い合わせ先。実際に使える連絡先が設定されたときだけ表示する(架空の連絡先は出さない)。
//   NEXT_PUBLIC_SUPPORT_CONTACT_URL   https: / mailto: / tel: のいずれか
//   NEXT_PUBLIC_SUPPORT_CONTACT_LABEL 表示名(省略時は「運営へのお問い合わせ」)
// 未設定のときは、リンクの無い案内文だけを出す(本番前に設定が必要。docs/plans/lavi-notification-cutover-plan.md)。

export interface SupportContact {
  href: string;
  label: string;
}

export function getSupportContact(): SupportContact | null {
  const raw = process.env.NEXT_PUBLIC_SUPPORT_CONTACT_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["https:", "mailto:", "tel:"].includes(url.protocol)) return null;
  } catch {
    return null;
  }
  return { href: raw, label: process.env.NEXT_PUBLIC_SUPPORT_CONTACT_LABEL?.trim() || "運営へのお問い合わせ" };
}
