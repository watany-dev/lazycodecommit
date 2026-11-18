# ADR 0006: 未読判定

## Status

Accepted.

## Context

仕様書は、PR の `lastActivityDate` がローカルに保存した最終閲覧時刻より新しければ
未読とする。コメント投稿で `lastActivityDate` が更新されるかは確認していない。

API リファレンスの記述は「The day and time of the last user or system activity on
the pull request」だけで、どの操作が含まれるかは書かれていない
（[PullRequest](https://docs.aws.amazon.com/codecommit/latest/APIReference/API_PullRequest.html)）。
この判断の時点では実機で確かめる AWS 環境がない。

## Decision

- 未読は `lastActivityDate` と最終閲覧時刻の比較で判定する（仕様書のまま）。
- フェーズ3（ホーム）の完了条件に、次の実機確認を加える。
  - 他人がコメントを投稿したとき、インラインコメントと返信を含めて
    `lastActivityDate` が更新されるか。
  - 承認、承認取り消し、ソースブランチへの push で更新されるか。
- 更新されない操作があれば、その操作の最新日時もあわせて見る。コメントなら
  `GetCommentsForPullRequest` の最新の作成日時を使う。

## Consequences

- フェーズ1〜2の実装はこの判断に依存しない。
- 確認結果はこの ADR に追記する。
- 確認は `scripts/realcheck/realcheck.mjs` で行う（[手順](../dev/real-aws-check.md)）。

## 実機の結果（2026-11-18、ap-northeast-1）

自分の操作では、コメント・インラインコメント・返信・タイトル変更・ソースブランチへの
push で `lastActivityDate` が動いた。リアクションでは動かなかった。他人の操作は
`--other-profile` なしで回したため未確認。

リアクションは未読の理由にしない。GitHub もリアクションでは通知しない。拾うには
コメントごとに `GetCommentReactions` を呼ぶことになり、ホームを開くたびの呼び出しが
コメント数に比例して増え、見合わない。realcheck は、リアクションで動かないことを
DIFF ではなく INFO として記録する。
