"use client";

import { useState } from "react";

interface Template {
  id: string;
  name: string;
  description: string | null;
}

interface Props {
  templates: Template[];
  onSelect: (templateId: string | null) => Promise<void>;
  error: string | null;
}

export default function TemplatePicker({ templates, onSelect, error }: Props) {
  const [selectingId, setSelectingId] = useState<string | null>(null);

  async function handleSelect(id: string | null) {
    setSelectingId(id ?? "scratch");
    await onSelect(id);
    setSelectingId(null);
  }

  const cards: Template[] = [
    ...templates,
    { id: "scratch", name: "0から作成", description: "空のアンケートから自分で質問を作成します。" },
  ];

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => {
          const isScratch = card.id === "scratch";
          const isSelecting = selectingId === card.id;
          return (
            <div
              key={card.id}
              className="flex flex-col justify-between rounded-2xl bg-white p-5 shadow-sm"
            >
              <div>
                <p className="font-medium text-stone-800">{card.name}</p>
                {card.description && (
                  <p className="mt-1 text-sm text-stone-500">{card.description}</p>
                )}
              </div>
              <button
                type="button"
                disabled={selectingId !== null}
                onClick={() => handleSelect(isScratch ? null : card.id)}
                className="mt-4 w-full rounded-lg bg-sage py-2 text-sm font-medium text-white transition hover:bg-sage-dark disabled:opacity-50"
              >
                {isSelecting
                  ? "作成しています..."
                  : isScratch
                    ? "空の状態から始める"
                    : "このテンプレートを使う"}
              </button>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}
    </div>
  );
}
