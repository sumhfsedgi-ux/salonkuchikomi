import Button from "@/components/ui/Button";
import type { AdjustMode } from "@/lib/blog/types";

interface Props {
  onAdjust: (mode: AdjustMode) => void;
}

const ITEMS: { mode: AdjustMode; label: string }[] = [
  { mode: "shorten", label: "短くする" },
  { mode: "soften", label: "もう少しやわらかく" },
  { mode: "detail", label: "もう少し詳しく" },
  { mode: "regenerate", label: "別パターンを作る" },
];

export default function AdjustMenu({ onAdjust }: Props) {
  return (
    <div>
      <p className="mb-1.5 text-sm text-ink-muted">少し調整する</p>
      <div className="grid grid-cols-2 gap-1.5">
        {ITEMS.map((item) => (
          <Button
            key={item.mode}
            type="button"
            variant="secondary"
            onClick={() => onAdjust(item.mode)}
            className="py-2 text-sm"
          >
            {item.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
