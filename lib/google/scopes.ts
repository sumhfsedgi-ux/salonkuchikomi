// SalonPack の共通 Google OAuth で扱う「機能ごとの Google 側の権限」。
// 予約通知は Gmail の読み取り、届いた口コミは Google ビジネスプロフィールの管理。
// 選んだ機能に必要な scope だけを要求し、両方使う場合だけ両方を要求する。

export const GOOGLE_SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  gbp: "https://www.googleapis.com/auth/business.manage",
} as const;

export type GoogleFeature = keyof typeof GOOGLE_SCOPES;
export const GOOGLE_FEATURES: readonly GoogleFeature[] = ["gmail", "gbp"];

/** アカウントの識別(id_token の sub)と表示用のメールアドレスのために常に要求する。 */
export const IDENTITY_SCOPES = ["openid", "email"] as const;

export function isGoogleFeature(value: unknown): value is GoogleFeature {
  return value === "gmail" || value === "gbp";
}

export function scopesForFeatures(features: readonly GoogleFeature[]): string[] {
  const unique = Array.from(new Set(features));
  return [...IDENTITY_SCOPES, ...unique.map((f) => GOOGLE_SCOPES[f])];
}

/**
 * トークン応答の `scope`(空白区切り)を配列にする。項目が無い・空のときは null
 * (= 何が許可されたか不明)。呼び出し側は null を「何も許可されていない」として扱い、
 * 要求した権限が全部あると推測しない。
 */
export function parseGrantedScopes(scope: string | null | undefined): string[] | null {
  if (typeof scope !== "string") return null;
  const parts = scope.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

/** 要求した機能のうち、実際に許可された scope に含まれるものだけを返す。 */
export function grantedFeatures(granted: readonly string[] | null, requested: readonly GoogleFeature[]): GoogleFeature[] {
  if (!granted) return [];
  const set = new Set(granted);
  return requested.filter((f) => set.has(GOOGLE_SCOPES[f]));
}

export function hasScopeFor(granted: readonly string[] | null | undefined, feature: GoogleFeature): boolean {
  return Boolean(granted?.includes(GOOGLE_SCOPES[feature]));
}
