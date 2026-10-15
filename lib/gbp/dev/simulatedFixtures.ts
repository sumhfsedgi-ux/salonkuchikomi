import type { GoogleReviewJson } from "@/lib/gbp/apiClient";
import type { SimulatedGbpUser } from "@/lib/gbp/simulated";

// 架空の Google の口コミの API(lib/gbp/simulated.ts)に入れる、架空のアカウント・ビジネス・口コミ。
// 実在のお客様・店舗・Google のデータではない。テストと、テスト用DBでの画面確認でだけ使う。
// ユーザーの sub は、共通の Google 連携の擬似 Google(lib/google/simulated.ts)の既定のユーザーと同じにする
// (owner@example.test がビジネスを管理している。staff@example.test は管理しているビジネスが無い)。
// 写真の URL は名前解決されない .invalid のドメイン(ネットワークに出ない。画面は「画像を表示できません」になる)。

export const SIM_OWNER_SUB = "100000000000000000001";
export const SIM_STAFF_SUB = "100000000000000000002";

function reviews(location: string, base: number): GoogleReviewJson[] {
  const at = (hoursAgo: number) => new Date(base - hoursAgo * 3_600_000).toISOString();
  const name = (n: number) => `accounts/sim-1/${location}/reviews/sim-r${n}`;
  return [
    {
      name: name(1),
      reviewer: { displayName: "架空 花子" },
      starRating: "FIVE",
      comment: "(架空の口コミ)カットの相談にていねいに乗ってもらえました。",
      createTime: at(30),
      updateTime: at(30),
    },
    {
      name: name(2),
      reviewer: { isAnonymous: true },
      starRating: "TWO",
      comment: "(架空の口コミ)予約の時間から少し待ちました。",
      createTime: at(52),
      updateTime: at(50),
      reviewReply: { comment: "(架空の返信)ご来店ありがとうございました。", updateTime: at(49), reviewReplyState: "REJECTED", policyViolation: "OFF_TOPIC" },
    },
    {
      name: name(3),
      reviewer: { displayName: "架空 太郎" },
      starRating: "FOUR",
      comment: "",
      createTime: at(80),
      updateTime: at(80),
      reviewReply: { comment: "(架空の返信)★のご評価ありがとうございます。", updateTime: at(70), reviewReplyState: "APPROVED" },
      reviewReplyUrl: "https://reply.invalid/sim-r3",
    },
    {
      name: name(4),
      reviewer: { displayName: "架空 次郎" },
      starRating: "THREE",
      comment: "(架空の口コミ)写真つき。",
      createTime: at(120),
      updateTime: at(120),
      reviewMediaItems: [{ thumbnailUrl: "https://media.invalid/sim-photo.jpg", thumbnailLabel: "架空の写真" }],
    },
  ];
}

const STARS = ["ONE", "TWO", "THREE", "FOUR", "FIVE"] as const;
const MANY_COMMENTS = [
  "(架空の口コミ)仕上がりがきれいで満足です。",
  "(架空の口コミ)予約の時間から少し待ちました。",
  "(架空の口コミ)説明がわかりやすかったです。",
  "(架空の口コミ)次回の予約は 03-0000-0000 に電話しました。詳しくは https://example.invalid/sim を見ました。",
  "",
];

/**
 * 画面確認用の、口コミが多い店舗(架空の Google は1ページ50件。取り込みは1回に最大5ページ)。
 * 「生成失敗」を含む口コミでは、架空の AI の返信案の作成が失敗する(lib/replyGeneration/mockGenerator.ts)。
 */
function manyReviews(location: string, base: number, count: number): GoogleReviewJson[] {
  const list: GoogleReviewJson[] = [];
  for (let i = 1; i <= count; i++) {
    const at = new Date(base - i * 5 * 3_600_000).toISOString();
    const review: GoogleReviewJson = {
      name: `accounts/sim-2/${location}/reviews/sim-m${i}`,
      reviewer: i % 7 === 0 ? { isAnonymous: true } : { displayName: `架空 利用者${i}` },
      starRating: STARS[(i * 3) % 5],
      comment: i === 3 ? "(架空の口コミ)生成失敗を試すための口コミです。" : MANY_COMMENTS[i % MANY_COMMENTS.length],
      createTime: at,
      updateTime: at,
    };
    if (i % 4 === 0) review.reviewReply = { comment: "(架空の返信)ご来店ありがとうございました。", updateTime: at, reviewReplyState: "APPROVED" };
    list.push(review);
  }
  return list;
}

export function simulatedGbpUsers(base: number = Date.now()): SimulatedGbpUser[] {
  return [
    {
      sub: SIM_OWNER_SUB,
      accounts: [
        {
          name: "accounts/sim-1",
          accountName: "架空のサロン(本部)",
          locations: [
            {
              name: "locations/sim-101",
              title: "架空のサロン 渋谷店",
              address: "〒150-0000 東京都 渋谷区 架空1-2-3",
              hasVoiceOfMerchant: true,
              reviews: reviews("locations/sim-101", base),
              averageRating: 3.5,
              totalReviewCount: 4,
            },
            {
              name: "locations/sim-102",
              title: "架空のサロン 新宿店",
              address: "〒160-0000 東京都 新宿区 架空4-5-6",
              hasVoiceOfMerchant: true,
              reviews: reviews("locations/sim-102", base).slice(0, 2),
              averageRating: 3.5,
              totalReviewCount: 2,
            },
            {
              name: "locations/sim-103",
              title: "架空のサロン 準備中の店",
              address: null,
              hasVoiceOfMerchant: false,
              reviews: [],
              averageRating: null,
              totalReviewCount: 0,
            },
          ],
        },
      ],
    },
    { sub: SIM_STAFF_SUB, accounts: [] },
  ];
}

/**
 * 画面確認用に足すアカウント(口コミ0件の店舗・口コミが多い店舗)。テスト(scripts/localdb)は accounts[0] だけを見る。
 * Google が「0件」と返す店舗(★の平均は無い)と、取り込みが複数ページに分かれる店舗。
 */
export function simulatedGbpScreenCheckAccount(base: number = Date.now()) {
  return {
    name: "accounts/sim-2",
    accountName: "架空のサロン(画面確認用)",
    locations: [
      {
        name: "locations/sim-201",
        title: "架空のサロン 口コミ0件の店",
        address: "〒100-0000 東京都 千代田区 架空7-8-9",
        hasVoiceOfMerchant: true,
        reviews: [],
        averageRating: null,
        totalReviewCount: 0,
      },
      {
        name: "locations/sim-202",
        title: "架空のサロン 口コミが多い店",
        address: null,
        hasVoiceOfMerchant: true,
        reviews: manyReviews("locations/sim-202", base, 120),
        averageRating: 3.6,
        totalReviewCount: 120,
      },
    ],
  };
}

/** 開発サーバー(テスト用DBでの画面確認)で使う架空の Google の利用者(テストの利用者に、画面確認用のアカウントを足す)。 */
export function simulatedGbpDevUsers(base: number = Date.now()): SimulatedGbpUser[] {
  return simulatedGbpUsers(base).map((user) =>
    user.sub === SIM_OWNER_SUB ? { ...user, accounts: [...user.accounts, simulatedGbpScreenCheckAccount(base)] } : user,
  );
}
