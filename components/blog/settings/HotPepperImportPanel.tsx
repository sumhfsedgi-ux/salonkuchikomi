"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import { importHotPepperBlogAction } from "@/app/dashboard/blog/settings/style-profile/actions";

interface Props {
  initialUrl: string | null;
}

export default function HotPepperImportPanel({ initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(
    null
  );

  async function handleImport() {
    if (importing) return;
    setImporting(true);
    setStatus(null);
    try {
      const result = await importHotPepperBlogAction(url);
      if (result.ok) {
        setStatus({
          type: "success",
          message: `${result.imported ?? 0}件取り込みました（スキップ${result.skippedExisting ?? 0}件・失敗${result.failed ?? 0}件）。`,
        });
      } else {
        setStatus({ type: "error", message: result.error ?? "取り込みに失敗しました。" });
      }
    } catch (err) {
      console.error(err);
      setStatus({ type: "error", message: "取り込みに失敗しました。もう一度お試しください。" });
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <p className="font-medium text-ink">Hot Pepper Beautyのブログを取り込む</p>
        <p className="mt-1 text-sm text-ink-muted">
          このサロンの公開ブログURL（例: https://beauty.hotpepper.jp/slnXXXXXXX/blog/）を登録すると、直近の記事（最大30件）を文体参考用に取り込みます。
        </p>
      </div>

      <Input
        type="text"
        value={url}
        placeholder="https://beauty.hotpepper.jp/slnXXXXXXX/blog/"
        onChange={(e) => setUrl(e.target.value)}
      />

      {status?.type === "error" && <Alert variant="error">{status.message}</Alert>}
      {status?.type === "success" && <Alert variant="success">{status.message}</Alert>}

      <Button type="button" onClick={handleImport} disabled={importing} fullWidth className="sm:w-auto sm:px-6">
        {importing ? "取り込んでいます…" : "過去ブログを取り込む"}
      </Button>
    </Card>
  );
}
