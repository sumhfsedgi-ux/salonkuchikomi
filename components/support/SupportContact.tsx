import type { SupportContact as Contact } from "@/lib/support/contact";

// 運営への問い合わせの導線。連絡先が設定されていればリンクを出す。未設定なら何も出さない
// (案内文は呼び出し側の文言に含める。架空の連絡先は出さない。本番前に NEXT_PUBLIC_SUPPORT_CONTACT_URL の設定が必要)。
export default function SupportContact({ contact, className }: { contact: Contact | null; className?: string }) {
  if (!contact) return null;
  const external = contact.href.startsWith("https:");
  return (
    <p className={className ?? "text-xs text-ink-muted"}>
      <a
        href={contact.href}
        className="text-sage-dark underline underline-offset-2"
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {contact.label}
      </a>
    </p>
  );
}
