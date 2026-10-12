import Link from "next/link";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import SupportContact from "@/components/support/SupportContact";
import { SUSPENDED_REASON } from "@/lib/features/access";
import { getSupportContact } from "@/lib/support/contact";

interface FeatureSuspendedProps {
  title: string;
}

// 運営がこの店舗の機能の利用を停止しているときの画面(404 やリダイレクトの繰り返しにしない)。
// 契約・運営内部の事情は書かない。保存済みの設定・データには触れない(再び許可されたら、そのまま使える)。
// サロン設定・ログアウトはメニューから今まで通り使える。
export default function FeatureSuspended({ title }: FeatureSuspendedProps) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} />
      <Card className="flex flex-col items-start gap-3">
        <Badge variant="neutral">利用停止中</Badge>
        <p className="text-sm text-ink">{SUSPENDED_REASON}</p>
        <p className="text-sm text-ink-muted">これまでに保存した設定やデータは残っています。</p>
        <Link href="/dashboard/settings" className={buttonClassName({ variant: "secondary", size: "sm" })}>
          サロン設定へ
        </Link>
      </Card>
      <SupportContact contact={getSupportContact()} />
    </div>
  );
}
