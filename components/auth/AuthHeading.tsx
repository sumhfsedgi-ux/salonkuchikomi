import type { Ref } from "react";

interface AuthHeadingProps {
  title: string;
  description?: string;
  /** 画面の中で見出しが切り替わったとき、読み上げと操作の位置を見出しに移すために使う。 */
  ref?: Ref<HTMLHeadingElement>;
}

// AuthShell のカードの見出し。送信のあとに見出しが切り替わるフォーム(新規登録)は、これを自分で出す。
export default function AuthHeading({ title, description, ref }: AuthHeadingProps) {
  return (
    <div className="mb-6">
      <h1 ref={ref} tabIndex={ref ? -1 : undefined} className="text-lg font-semibold text-ink focus:outline-none">
        {title}
      </h1>
      {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
    </div>
  );
}
