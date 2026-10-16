import type { GbpAccess } from "@/lib/gbp/access";
import type { Deadline } from "@/lib/notifications/jobs/runBudget";
import type { PushStore, RegistrationState } from "@/lib/reviews/alerts/store";

// Google Business Profile の通知設定(My Business Notifications API の accounts/{a}/notificationSetting)。
//   ・通知設定は GBP アカウントごとに1つ・トピック1つ(公式)。ほかのツールのトピックが入っていれば上書きしない(foreign)。
//   ・登録は、そのアカウントの店舗が LINE 通知を開始したとき(定期処理が行う)。空か SalonPack のトピックのときだけ、
//     NEW_REVIEW・UPDATED_REVIEW を設定する。
//   ・解除は、SalonPack のトピックが入っていて、そのアカウントで LINE 通知中の店舗が無くなったとき(種類を空・トピックを空に)。
//   ・Google の通知が来なくても、定期の確認(15分・60分)で取り込む(通知は早く気づくための補い)。

export const NOTIFICATION_TYPES = ["NEW_REVIEW", "UPDATED_REVIEW"] as const;
const BASE = "https://mybusinessnotifications.googleapis.com/v1";
const TIMEOUT_MS = 10_000;

export interface NotificationSetting {
  pubsubTopic: string | null;
  notificationTypes: string[];
}

export class NotificationSettingError extends Error {
  constructor(readonly status: number | null) {
    super(`gbp notification setting failed${status ? ` (${status})` : ""}`);
    this.name = "NotificationSettingError";
  }
}

export interface NotificationSettingApi {
  get(accessToken: string, accountName: string): Promise<NotificationSetting>;
  update(accessToken: string, accountName: string, setting: NotificationSetting): Promise<void>;
}

const ACCOUNT = /^accounts\/[^/\s]{1,100}$/;
const TOPIC = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/;

export function isValidTopic(topic: string | undefined | null): topic is string {
  return typeof topic === "string" && TOPIC.test(topic);
}

export function createHttpNotificationSettingApi(fetchImpl: typeof fetch = fetch): NotificationSettingApi {
  async function request(accessToken: string, url: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new NotificationSettingError(null);
    }
    if (!response.ok) throw new NotificationSettingError(response.status);
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
  return {
    async get(accessToken, accountName) {
      if (!ACCOUNT.test(accountName)) throw new NotificationSettingError(null);
      const body = (await request(accessToken, `${BASE}/${accountName}/notificationSetting`)) as { pubsubTopic?: unknown; notificationTypes?: unknown };
      return {
        pubsubTopic: typeof body.pubsubTopic === "string" && body.pubsubTopic !== "" ? body.pubsubTopic : null,
        notificationTypes: Array.isArray(body.notificationTypes) ? body.notificationTypes.filter((t): t is string => typeof t === "string") : [],
      };
    },
    async update(accessToken, accountName, setting) {
      if (!ACCOUNT.test(accountName)) throw new NotificationSettingError(null);
      const url = `${BASE}/${accountName}/notificationSetting?updateMask=pubsubTopic,notificationTypes`;
      await request(accessToken, url, {
        method: "PATCH",
        body: JSON.stringify({
          name: `${accountName}/notificationSetting`,
          pubsubTopic: setting.pubsubTopic ?? "",
          notificationTypes: setting.notificationTypes,
        }),
      });
    },
  };
}

/** 架空の Google(テスト用DB・ローカルのテスト)。アカウントごとの通知設定をメモリーに持つ。 */
export function createSimulatedNotificationSettingApi(initial: Record<string, NotificationSetting> = {}) {
  const settings = new Map<string, NotificationSetting>(Object.entries(initial));
  const calls: { op: "get" | "update"; accountName: string; setting?: NotificationSetting }[] = [];
  const api: NotificationSettingApi = {
    async get(_token, accountName) {
      calls.push({ op: "get", accountName });
      return settings.get(accountName) ?? { pubsubTopic: null, notificationTypes: [] };
    },
    async update(_token, accountName, setting) {
      calls.push({ op: "update", accountName, setting });
      settings.set(accountName, { pubsubTopic: setting.pubsubTopic || null, notificationTypes: [...setting.notificationTypes] });
    },
  };
  return { api, settings, calls };
}

/** 今の設定と SalonPack のトピックから、登録で何をするか。 */
export function registrationAction(current: NotificationSetting, ourTopic: string): "set" | "keep" | "foreign" {
  if (current.pubsubTopic && current.pubsubTopic !== ourTopic) return "foreign";
  if (current.pubsubTopic === ourTopic && NOTIFICATION_TYPES.every((t) => current.notificationTypes.includes(t))) return "keep";
  return "set";
}

export interface RegistrationDeps {
  store: Pick<PushStore, "registrationWork" | "setRegistration">;
  api: NotificationSettingApi;
  access: Pick<GbpAccess, "binding" | "accessToken">;
  topic: string;
  deadline: Deadline;
}

export interface RegistrationSummary {
  registered: number;
  unregistered: number;
  foreign: number;
  errors: number;
}

const STEP_MS = 2 * TIMEOUT_MS + 2_000;

/** 登録・解除が要る GBP アカウントを順に処理する(締切まで)。 */
export async function syncNotificationRegistrations(deps: RegistrationDeps): Promise<RegistrationSummary> {
  const summary: RegistrationSummary = { registered: 0, unregistered: 0, foreign: 0, errors: 0 };
  if (!deps.deadline.allows(STEP_MS)) return summary;
  for (const work of await deps.store.registrationWork()) {
    if (!deps.deadline.allows(STEP_MS)) break;
    let state: RegistrationState;
    try {
      const binding = await deps.access.binding(work.salonId);
      if (!binding || binding.googleAccountId !== work.googleAccountId) throw new NotificationSettingError(null);
      const token = await deps.access.accessToken(binding);
      const current = await deps.api.get(token, work.accountName);
      if (work.action === "register") {
        const action = registrationAction(current, deps.topic);
        if (action === "foreign") {
          state = "foreign";
          summary.foreign++;
        } else {
          if (action === "set") await deps.api.update(token, work.accountName, { pubsubTopic: deps.topic, notificationTypes: [...NOTIFICATION_TYPES] });
          state = "ours";
          summary.registered++;
        }
      } else {
        // SalonPack のトピックのときだけ外す(ほかのツールが入れ替えていたら触らない)。
        if (current.pubsubTopic === deps.topic) {
          await deps.api.update(token, work.accountName, { pubsubTopic: null, notificationTypes: [] });
        }
        state = current.pubsubTopic && current.pubsubTopic !== deps.topic ? "foreign" : "none";
        summary.unregistered++;
      }
    } catch {
      state = "error";
      summary.errors++;
    }
    await deps.store.setRegistration(work.accountName, state, work.googleAccountId);
  }
  return summary;
}
