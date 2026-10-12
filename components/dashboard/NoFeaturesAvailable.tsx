import Link from "next/link";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import { buttonClassName } from "@/components/ui/Button";
import SupportContact from "@/components/support/SupportContact";
import { getSupportContact } from "@/lib/support/contact";

interface NoFeaturesAvailableProps {
  title: string;
}

// 利用できる機能が無い店舗(口コミプランで口コミを使えない)の画面。404 やリダイレクトの繰り返しにしない。
// 「停止」や契約・運営内部の事情は書かない。保存済みの設定・データには触れない(再び使えるようになれば、そのまま使える)。
// サロン設定・ログアウトはメニューから今まで通り使える。
export default function NoFeaturesAvailable({ title }: NoFeaturesAvailableProps) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} />
      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm text-ink">現在ご利用いただける機能はありません。</p>
        <p className="text-sm text-ink-muted">これまでに保存した設定やデータは残っています。</p>
        <Link href="/dashboard/settings" className={buttonClassName({ variant: "secondary", size: "sm" })}>
          サロン設定へ
        </Link>
      </Card>
      <SupportContact contact={getSupportContact()} />
    </div>
  );
}
