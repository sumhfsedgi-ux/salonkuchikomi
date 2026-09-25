import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";

interface Props {
  onReset: () => void;
}

export default function DoneStep({ onReset }: Props) {
  return (
    <Card className="flex flex-col gap-4 text-center">
      <p className="font-medium text-ink">コピーしました</p>
      <p className="text-sm text-ink-muted">
        Hot Pepper Beautyのブログ編集画面に貼り付けてご利用ください。
      </p>
      <Button type="button" onClick={onReset} fullWidth>
        もう1記事作る
      </Button>
    </Card>
  );
}
