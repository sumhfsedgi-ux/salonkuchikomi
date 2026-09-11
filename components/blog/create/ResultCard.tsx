import Card from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Textarea from "@/components/ui/Textarea";
import Button from "@/components/ui/Button";

interface Props {
  title: string;
  body: string;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onCopyTitle: () => void;
  onCopyBody: () => void;
  onCopyAll: () => void;
}

export default function ResultCard({
  title,
  body,
  onTitleChange,
  onBodyChange,
  onCopyTitle,
  onCopyBody,
  onCopyAll,
}: Props) {
  return (
    <Card className="flex flex-col gap-4">
      <p className="font-medium text-ink">ブログができました</p>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="blog-title" className="text-sm font-medium text-ink">
            タイトル
          </label>
          <button
            type="button"
            onClick={onCopyTitle}
            className="min-h-9 text-sm text-sage-dark underline-offset-2 hover:underline"
          >
            コピー
          </button>
        </div>
        <Input id="blog-title" type="text" value={title} onChange={(e) => onTitleChange(e.target.value)} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="blog-body" className="text-sm font-medium text-ink">
            本文
          </label>
          <button
            type="button"
            onClick={onCopyBody}
            className="min-h-9 text-sm text-sage-dark underline-offset-2 hover:underline"
          >
            コピー
          </button>
        </div>
        <Textarea
          id="blog-body"
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          rows={8}
          className="leading-relaxed"
        />
      </div>

      <Button type="button" onClick={onCopyAll} fullWidth>
        タイトル＋本文をコピー
      </Button>
    </Card>
  );
}
