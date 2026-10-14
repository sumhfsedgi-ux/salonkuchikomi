// 利用区分(salons.service_status。0025)。契約プランとは別に管理する(DBに触れない)。
//   pending ......... 利用開始待ち(新しい店舗の既定。お客様自身の新規登録は必ずこれ。サービスの機能は使えない)
//   complimentary ... 無償提供(決済なしで、許可された機能を使える。0025 の適用時点で存在した店舗はこれ)
//   test ............ テスト店舗(運営の動作確認用。許可された機能を使えるが、機能や権限を広げる理由にはしない)
// 利用中かどうかの判定は、DB の salon_service_active と同じにする(将来の決済の状態は、両方に足す)。

export const SERVICE_STATUSES = ["pending", "complimentary", "test"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  pending: "利用開始待ち",
  complimentary: "無償提供",
  test: "テスト店舗",
};

/** 運営の画面での説明(区分の選択肢の下に出す)。 */
export const SERVICE_STATUS_DESCRIPTIONS: Record<ServiceStatus, string> = {
  pending: "サービスの機能は使えません。ログインと、登録内容の確認・修正だけができます。",
  complimentary: "決済なしで、許可した機能を使えます。",
  test: "運営の動作確認用です。許可した機能を使えます。機能や権限は広がりません。メールや LINE の送信も自動では始まりません。",
};

export function isServiceStatus(value: unknown): value is ServiceStatus {
  return typeof value === "string" && (SERVICE_STATUSES as readonly string[]).includes(value);
}

/** 利用中の区分か。知らない値・無い値は利用中ではないとして扱う(使える側に倒さない)。 */
export function isServiceActive(status: unknown): boolean {
  return status === "complimentary" || status === "test";
}

export type RegistrationSource = "existing" | "self_signup" | "operator";

export const REGISTRATION_SOURCE_LABELS: Record<RegistrationSource, string> = {
  existing: "既存の店舗(移行)",
  self_signup: "お客様による登録",
  operator: "運営による登録",
};

export function isRegistrationSource(value: unknown): value is RegistrationSource {
  return value === "existing" || value === "self_signup" || value === "operator";
}
