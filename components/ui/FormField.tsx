import type { ReactNode } from "react";
import Label from "@/components/ui/Label";

interface FormFieldProps {
  id: string;
  label: string;
  /** 必須なら「必須」、任意なら「任意」を見出しの横に出す(どちらも指定しなければ出さない)。 */
  requirement?: "required" | "optional";
  help?: ReactNode;
  error?: string | null;
  children: ReactNode;
}

// 入力欄の見出し・必須/任意の表示・補足・欄の近くのエラーをそろえる。入力欄には fieldAria() の属性を付ける
// (エラーと補足を読み上げで結び付け、誤りのある欄を aria-invalid にする)。
export default function FormField({ id, label, requirement, help, error, children }: FormFieldProps) {
  return (
    <div>
      <Label htmlFor={id}>
        <span>{label}</span>
        {requirement === "required" && (
          <span className="ml-2 rounded bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger">必須</span>
        )}
        {requirement === "optional" && (
          <span className="ml-2 rounded bg-beige px-1.5 py-0.5 text-xs font-medium text-ink-muted">任意</span>
        )}
      </Label>
      {help && (
        <p id={`${id}-help`} className="mb-1 text-xs text-ink-muted">
          {help}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  );
}

/** 入力欄に付ける属性(エラー・補足との結び付け)。 */
export function fieldAria(id: string, opts: { error?: string | null; help?: boolean }) {
  const describedBy = [opts.help ? `${id}-help` : null, opts.error ? `${id}-error` : null].filter(Boolean).join(" ");
  return {
    "aria-invalid": opts.error ? (true as const) : undefined,
    "aria-describedby": describedBy || undefined,
  };
}

/** 最初の誤りのある欄に移る(送信のあと)。 */
export function focusFirstError(order: readonly string[], errors: Partial<Record<string, string>>, idOf: (field: string) => string = (f) => f) {
  const first = order.find((f) => errors[f]);
  if (!first || typeof document === "undefined") return;
  const el = document.getElementById(idOf(first));
  if (el && "focus" in el) (el as HTMLElement).focus();
}
