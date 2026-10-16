// 利用区分(salons.service_status。0025・0026)。契約プランとは別に管理する(DBに触れない)。
//   pending ......... お申し込み手続き中(新しい店舗の既定。止めた既存の店舗は「利用停止中」と表示する。値は同じ pending。登録しただけでは、サービスの機能は使えない。
//                     通常のお客様は、将来、プラン選択・決済の完了で自動で利用を始める。運営の承認では始めない)
//   complimentary ... 無料提供(0025 の時点で存在した店舗だけ。新しい店舗には選べない。止めた既存の店舗を戻すときだけ選べる)
//   test ............ テスト用(運営が指定する動作確認用。プランが決まっている店舗だけ。お客様の利用開始の代わりには使わない)
// 利用中かどうかの判定は、DB の salon_service_active と同じにする。将来の決済で「通常利用」の値を、両方に足す。
//
// 画面の言葉は、場面で分ける(値はどれも同じ):
//   - 新しい店舗の登録のときの選択(サロンを追加・登録内容の確認): REGISTRATION_KIND_*「通常登録/テスト用」
//   - 今の状態(一覧・詳細・変更履歴): serviceStatusLabel「お申し込み手続き中(止めた既存の店舗は利用停止中)/無料提供/テスト用」
//     (通常登録を選んだだけで、利用開始済みと誤解させない)
//   - 区分の変更: serviceStatusChoices と SERVICE_STATUS_CHANGE_OPTIONS(結果が伝わる言葉。pending は「利用停止中に変更」で、
//     停止の意味を隠さない。選べる変更は DB の admin_update_salon_service_status と同じ規則)

export const SERVICE_STATUSES = ["pending", "complimentary", "test"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** 今の状態の表示(一覧・詳細・変更履歴・絞り込み)。 */
export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  pending: "お申し込み手続き中",
  complimentary: "無料提供",
  test: "テスト用",
};

/** 運営が止めた店舗(止めた既存の店舗)の表示。値は pending のまま。 */
export const SERVICE_STOPPED_LABEL = "利用停止中";

/** 絞り込み(pending は、手続き中も停止中も含む)。 */
export const SERVICE_PENDING_FILTER_LABEL = `${SERVICE_STATUS_LABELS.pending}・${SERVICE_STOPPED_LABEL}`;

/** 今の状態の表示。登録経路が分かるときは、止めた既存の店舗を「利用停止中」と出す。 */
export function serviceStatusLabel(status: ServiceStatus, source?: RegistrationSource | null): string {
  return status === "pending" && source === "existing" ? SERVICE_STOPPED_LABEL : SERVICE_STATUS_LABELS[status];
}

/** 新しい店舗の登録種別(サロンを追加)。無料提供は選べない。 */
export const REGISTRATION_KINDS = ["pending", "test"] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export const REGISTRATION_KIND_LABELS: Record<RegistrationKind, string> = {
  pending: "通常登録",
  test: "テスト用",
};

export const REGISTRATION_KIND_DESCRIPTIONS: Record<RegistrationKind, string> = {
  pending: "これから通常の契約で利用するお客様の登録です。登録しただけでは、サービスの機能は使えません(プラン選択・お支払いの手続きは準備中です)。",
  test: "運営の動作確認に使用する店舗です。料金は発生しません。",
};

export function isRegistrationKind(value: unknown): value is RegistrationKind {
  return value === "pending" || value === "test";
}

/** 区分を変えるときの選択肢の言葉(変更の結果が伝わる言葉)。 */
export const SERVICE_STATUS_CHANGE_OPTIONS: Record<ServiceStatus, { label: string; description: string }> = {
  pending: { label: "利用停止中に変更", description: "サービスの機能が使えなくなります(ログインと、登録内容の確認・修正だけができます)。" },
  complimentary: {
    label: "無料提供に戻す",
    description: "既存の店舗だけが選べます。これまでどおり、料金を請求せず、許可した機能を使えるようにします。",
  },
  test: {
    label: "テスト用に変更",
    description: "運営の動作確認用です。料金は発生せず、許可した機能を使えます。お客様の利用開始の代わりには使いません。",
  },
};

export const TEST_NEEDS_PLAN_REASON = "プランが未定のため、テスト用にできません(テスト用の店舗は、サロンを追加から「テスト用」で登録してください)。";

export interface ServiceStatusChoice {
  status: ServiceStatus;
  /** false なら、理由を出して押せなくする。 */
  available: boolean;
  reason: string | null;
}

/**
 * 今の区分から選べる変更(今の区分は含めない)。DB の admin_update_salon_service_status と同じ規則:
 *   - 無料提供は、0025 の時点の店舗(registration_source = existing)だけ(それ以外の店舗には出さない)
 *   - プランが仮の値の店舗は、テスト用にできない(理由を出して押せなくする)
 */
export function serviceStatusChoices(params: {
  status: ServiceStatus;
  registrationSource: RegistrationSource;
  planPlaceholder: boolean;
}): ServiceStatusChoice[] {
  const choices: ServiceStatusChoice[] = [];
  for (const s of SERVICE_STATUSES) {
    if (s === params.status) continue;
    if (s === "complimentary" && params.registrationSource !== "existing") continue;
    if (s === "test" && params.planPlaceholder) {
      choices.push({ status: s, available: false, reason: TEST_NEEDS_PLAN_REASON });
      continue;
    }
    choices.push({ status: s, available: true, reason: null });
  }
  return choices;
}

/** テスト用の店舗の注意(登録・区分の変更の確認で出す)。外部への送信を止める仕組みではないことを伝える。 */
export const TEST_SEND_NOTICE = "テスト用でも、操作によっては実際のメール・LINE の送信が発生することがあります。";

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
