import ReferencePostListItem from "@/components/blog/settings/ReferencePostListItem";
import type { SalonReferencePost } from "@/lib/blog/types";

interface Props {
  posts: SalonReferencePost[];
}

export default function ReferencePostList({ posts }: Props) {
  if (posts.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        まだ取り込んだ記事がありません。上のフォームからHot PepperブログのURLを登録してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">
        文体プロファイルに使う記事にチェックを入れてください（3件以上推奨）。
      </p>
      <ul className="flex flex-col gap-2">
        {posts.map((post) => (
          <li key={post.id}>
            <ReferencePostListItem post={post} />
          </li>
        ))}
      </ul>
    </div>
  );
}
