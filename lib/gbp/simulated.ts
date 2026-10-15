import { GbpApiError, type GbpApiClient, type GbpApiErrorKind, type GoogleReviewJson } from "@/lib/gbp/apiClient";

// どこにもつながない「架空の Google」の口コミの API(テストと、テスト用DBでの画面確認だけで使う。本番では使わない)。
// 認可・トークンは共通の Google 連携の擬似 Google(lib/google/simulated.ts)が受け持つ。ここは口コミの API だけを真似る。
//   ・アクセストークンは「simgbp:{Google のユーザーの sub}:{共通の擬似 Google が出したトークン}」の形で受け取る
//     (lib/gbp/tokens.ts が、架空モードのときだけこの形にする)。sub で、そのユーザーが管理するアカウントを決める
//   ・返信の投稿(updateReply)・削除(deleteReply)は、公式資料の形(ReviewReply)だけを返す。審査の状態を応答に入れるかは
//     切り替えられる(本物の応答に入るかは未確認のため、入らない場合も確かめる)
//   ・続きのページの指定(pageToken)は、expirePageTokens() で古いものを受け付けなくできる
//   ・次の1回だけ失敗させる(failNext)・反映したうえで応答を返さない(loseNextResponse)・遅らせる(delayNext)
// 実在の Google のアカウント・店舗・口コミではない。

export interface SimulatedLocation {
  name: string;
  title: string;
  address: string | null;
  hasVoiceOfMerchant: boolean;
  reviews: GoogleReviewJson[];
  averageRating: number | null;
  totalReviewCount: number | null;
}

export interface SimulatedAccount {
  name: string;
  accountName: string | null;
  locations: SimulatedLocation[];
}

export interface SimulatedGbpUser {
  sub: string;
  accounts: SimulatedAccount[];
}

export type SimulatedOperation = "accounts" | "locations" | "reviews" | "review" | "reply" | "delete_reply";

export interface SimulatedGbp {
  api: GbpApiClient;
  addReview(locationName: string, review: GoogleReviewJson): void;
  removeReview(reviewName: string): void;
  editReview(reviewName: string, comment: string): void;
  /** 次の1回だけ、その操作を失敗させる。 */
  failNext(operation: SimulatedOperation, error: Error): void;
  /** 次の1回だけ、その操作の応答を遅らせる(ミリ秒)。 */
  delayNext(operation: SimulatedOperation, ms: number): void;
  expirePageTokens(): void;
  /** 次の1回だけ、返信の書き込みを反映したうえで、応答を返さずに失敗させる(時間切れ・通信の切断)。 */
  loseNextResponse(operation: "reply" | "delete_reply", error: Error): void;
  setReplyResponseIncludesState(include: boolean): void;
  setReplyState(reviewName: string, state: "PENDING" | "APPROVED" | "REJECTED", policyViolation?: string): void;
  /** SalonPack の外(Google の画面・ほかのツール)で返信を書き換える・消す。 */
  setReplyExternally(reviewName: string, comment: string | null): void;
  replyOf(reviewName: string): { comment?: string; reviewReplyState?: string } | null;
  setAverage(locationName: string, averageRating: number | null, totalReviewCount: number | null): void;
  readonly calls: string[];
}

export const SIM_GBP_TOKEN_PREFIX = "simgbp:";

export function simulatedGbpToken(sub: string, accessToken: string): string {
  return `${SIM_GBP_TOKEN_PREFIX}${sub}:${accessToken}`;
}

/** 失敗の種類だけの Error(テストで使う)。 */
export const apiFailure = (kind: GbpApiErrorKind) => new GbpApiError(kind);

export function createSimulatedGbp(options: { users: SimulatedGbpUser[]; now?: () => number }): SimulatedGbp {
  const now = options.now ?? Date.now;
  const users = new Map(options.users.map((u) => [u.sub, structuredClone(u)]));
  const failures = new Map<SimulatedOperation, Error>();
  const delays = new Map<SimulatedOperation, number>();
  const lostResponses = new Map<"reply" | "delete_reply", Error>();
  const calls: string[] = [];
  let pageGeneration = 1;
  let replyIncludesState = true;

  const maybeFail = async (op: SimulatedOperation) => {
    calls.push(op);
    const delay = delays.get(op);
    if (delay) {
      delays.delete(op);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const error = failures.get(op);
    if (error) {
      failures.delete(op);
      throw error;
    }
  };

  const userFor = (accessToken: string) => {
    if (!accessToken.startsWith(SIM_GBP_TOKEN_PREFIX)) throw new GbpApiError("unauthorized");
    const sub = accessToken.slice(SIM_GBP_TOKEN_PREFIX.length).split(":")[0];
    const user = users.get(sub);
    if (!user) return { sub, accounts: [] } satisfies SimulatedGbpUser;
    return user;
  };

  const accountOf = (user: SimulatedGbpUser, accountName: string) => {
    const account = user.accounts.find((a) => a.name === accountName);
    if (!account) throw new GbpApiError("permission_denied");
    return account;
  };

  const findLocation = (user: SimulatedGbpUser, accountName: string, locationName: string) => {
    const location = accountOf(user, accountName).locations.find((l) => l.name === locationName);
    if (!location) throw new GbpApiError("permission_denied");
    return location;
  };

  const allLocations = function* () {
    for (const user of users.values()) for (const account of user.accounts) for (const location of account.locations) yield location;
  };

  const reviewByName = (reviewName: string) => {
    for (const location of allLocations()) {
      const review = location.reviews.find((r) => r.name === reviewName);
      if (review) return review;
    }
    return null;
  };

  const ownReview = (accessToken: string, reviewName: string) => {
    const user = userFor(accessToken);
    const [, a, , l] = reviewName.split("/");
    const location = findLocation(user, `accounts/${a}`, `locations/${l}`);
    const review = location.reviews.find((r) => r.name === reviewName);
    if (!review) throw new GbpApiError("not_found");
    return review;
  };

  const api: GbpApiClient = {
    mode: "simulate",
    async listAccounts(accessToken) {
      await maybeFail("accounts");
      return userFor(accessToken).accounts.map((a) => ({ name: a.name, accountName: a.accountName }));
    },
    async listLocations(accessToken, accountName) {
      await maybeFail("locations");
      return accountOf(userFor(accessToken), accountName).locations.map((l) => ({
        name: l.name,
        title: l.title,
        address: l.address,
        hasVoiceOfMerchant: l.hasVoiceOfMerchant,
      }));
    },
    async listReviews(accessToken, accountName, locationName, pageToken) {
      await maybeFail("reviews");
      const location = findLocation(userFor(accessToken), accountName, locationName);
      const sorted = [...location.reviews].sort((a, b) => Date.parse(b.updateTime) - Date.parse(a.updateTime));
      let offset = 0;
      if (pageToken) {
        const [generation, at] = pageToken.split(":");
        if (Number(generation) !== pageGeneration || !/^\d+$/.test(at ?? "")) throw new GbpApiError("invalid_argument");
        offset = Number(at);
      }
      const page = sorted.slice(offset, offset + 50);
      return {
        reviews: structuredClone(page),
        averageRating: location.averageRating,
        totalReviewCount: location.totalReviewCount,
        nextPageToken: offset + 50 < sorted.length ? `${pageGeneration}:${offset + 50}` : null,
      };
    },
    async getReview(accessToken, reviewName) {
      await maybeFail("review");
      return structuredClone(ownReview(accessToken, reviewName));
    },
    async updateReply(accessToken, reviewName, comment) {
      await maybeFail("reply");
      const review = ownReview(accessToken, reviewName);
      if (typeof comment !== "string" || !comment.trim() || Buffer.byteLength(comment, "utf8") > 4096) throw new GbpApiError("bad_response");
      review.reviewReply = { comment, updateTime: new Date(now()).toISOString(), reviewReplyState: "PENDING" };
      const lost = lostResponses.get("reply");
      if (lost) {
        lostResponses.delete("reply");
        throw lost;
      }
      const { comment: c, updateTime, reviewReplyState } = review.reviewReply;
      return replyIncludesState ? { comment: c, updateTime, reviewReplyState } : { comment: c, updateTime };
    },
    async deleteReply(accessToken, reviewName) {
      await maybeFail("delete_reply");
      const review = ownReview(accessToken, reviewName);
      delete review.reviewReply;
      const lost = lostResponses.get("delete_reply");
      if (lost) {
        lostResponses.delete("delete_reply");
        throw lost;
      }
    },
  };

  return {
    api,
    addReview(locationName, review) {
      for (const location of allLocations()) if (location.name === locationName) location.reviews.push(structuredClone(review));
    },
    removeReview(reviewName) {
      for (const location of allLocations()) location.reviews = location.reviews.filter((r) => r.name !== reviewName);
    },
    editReview(reviewName, comment) {
      const review = reviewByName(reviewName);
      if (review) {
        review.comment = comment;
        review.updateTime = new Date(now()).toISOString();
      }
    },
    failNext: (operation, error) => {
      failures.set(operation, error);
    },
    delayNext: (operation, ms) => {
      delays.set(operation, ms);
    },
    expirePageTokens: () => {
      pageGeneration += 1;
    },
    loseNextResponse: (operation, error) => {
      lostResponses.set(operation, error);
    },
    setReplyResponseIncludesState: (include) => {
      replyIncludesState = include;
    },
    setReplyState(reviewName, state, policyViolation) {
      const review = reviewByName(reviewName);
      if (!review?.reviewReply) return;
      review.reviewReply = {
        ...review.reviewReply,
        reviewReplyState: state,
        ...(state === "REJECTED" && policyViolation ? { policyViolation } : { policyViolation: undefined }),
      };
    },
    setReplyExternally(reviewName, comment) {
      const review = reviewByName(reviewName);
      if (!review) return;
      if (comment === null) delete review.reviewReply;
      else review.reviewReply = { comment, updateTime: new Date(now()).toISOString(), reviewReplyState: "APPROVED" };
    },
    replyOf(reviewName) {
      const reply = reviewByName(reviewName)?.reviewReply;
      return reply ? structuredClone(reply) : null;
    },
    setAverage(locationName, averageRating, totalReviewCount) {
      for (const location of allLocations()) {
        if (location.name === locationName) {
          location.averageRating = averageRating;
          location.totalReviewCount = totalReviewCount;
        }
      }
    },
    calls,
  };
}

/** 開発サーバー(テスト用DBでの画面確認)で使う、プロセス内で1つの架空の口コミの API。 */
export function getDevSimulatedGbp(createUsers: () => SimulatedGbpUser[]): SimulatedGbp {
  const holder = globalThis as unknown as { __salonpackSimulatedGbp?: SimulatedGbp };
  holder.__salonpackSimulatedGbp ??= createSimulatedGbp({ users: createUsers() });
  return holder.__salonpackSimulatedGbp;
}
