# ADR 0009: CI 結果の表示

## Status

Proposed. ADR 0007 のうち「CI 結果の表示」を置き換える。

## Context

ADR 0007 で後回しにした「CodeBuild と CodePipeline の結果を PR に表示する」を
フェーズ4の後に入れる。CodeCommit の PR と CI の実行を結び付ける標準の仕組みは
ない。AWS の公式ドキュメントで確かめたことは次のとおり。

- CodePipeline の V2 パイプラインのプルリクエストのトリガーは、接続
  （`CodeStarSourceConnection`。GitHub、Bitbucket、GitLab）のソースだけが対象で、
  CodeCommit のソースは EventBridge による変更検出で動く。CodeCommit の PR に
  対してパイプラインが走る標準の構成はない。
- CodeBuild のビルド（`BatchGetBuilds` の `Build`）は、`resolvedSourceVersion` に
  実際にビルドしたコミット ID を持つ。CodeCommit のソースでも、CodePipeline から
  呼ばれたビルドでも同じ。`sourceVersion` は要求したブランチ名やコミット ID。
- CodePipeline の実行（`ListPipelineExecutions` の `PipelineExecutionSummary`）は、
  `sourceRevisions[].revisionId` にソースのリビジョンを持つ。CodeCommit のソース
  ではコミット ID になる。`ListPipelineExecutions` は1回で最大 100 件、直近 12 か月。
- AWS がブログで紹介している PR 検証の構成は、EventBridge の
  `pullRequestCreated` / `pullRequestSourceBranchUpdated` で CodeBuild を
  `sourceVersion` = PR のソースコミットで起動し、Lambda が結果を PR にコメント
  する、というもの。コメントの書式は決まっていない。
- CodeBuild のプロジェクトや CodePipeline のパイプラインから、どの CodeCommit
  リポジトリを見ているかを逆に引く API はない。全プロジェクト
  （`ListProjects` + `BatchGetProjects`）か全パイプライン（`ListPipelines` +
  `GetPipeline`）を読んでソースの設定を調べるしかない。

つまり、実行と PR を確実に結び付けられる手掛かりは「PR のソースコミット ID」
だけで、どのプロジェクトとパイプラインを見るかは別に知る必要がある。

## Decision

### 結び付け方

設定ファイルに、リポジトリごとに見る CodeBuild プロジェクトと CodePipeline の
パイプラインを書く。その直近の実行から、ソースコミットが PR の `sourceCommit` と
一致するものを PR の CI 結果とする。

```json
{
  "ci": {
    "my-service": {
      "codebuild": ["my-service-pr-check"],
      "codepipeline": ["my-service-release"]
    }
  }
}
```

- 一致の条件は、CodeBuild は `resolvedSourceVersion`、CodePipeline は
  `sourceRevisions` のどれかの `revisionId` が `sourceCommit` と等しいこと。
- プロジェクトとパイプラインごとに、一致した中で最も新しい実行を1件出す。
- 直近の実行だけを見る。CodeBuild は `ListBuildsForProject`（新しい順）の先頭
  20 件を `BatchGetBuilds` で読む。CodePipeline は `ListPipelineExecutions` を
  `maxResults` 20 で1回呼ぶ。プロジェクトとパイプラインごとに API 1〜2 回で済み、
  PR の数に比例しない。ホームでは1回の取得をそのリポジトリの全 PR で使う。
- リージョンと認証情報は CodeCommit と同じものを使う。別アカウントや別
  リージョンの CI は扱わない。
- `ci` にリポジトリがなければ、CodeBuild と CodePipeline の API を一度も呼ばず、
  SDK のチャンクも読み込まない。この機能を使わない人には権限も起動時間も
  増えない。

採らなかった案:

- 自動検出（全プロジェクトとパイプラインのソース設定を読む）。設定は要らないが、
  `codebuild:ListProjects`、`BatchGetProjects`、`codepipeline:ListPipelines`、
  `GetPipeline` を全員に要求し、プロジェクトの数だけ呼び出しが増える。CodePipeline
  から呼ばれる CodeBuild はソースが `CODEPIPELINE` で、リポジトリが分からない。
  必要なら後で `ci` を書き出す補助コマンドとして足せる。
- PR コメントの解析。Lambda が書くコメントの書式は構成ごとに違い、どれが最新の
  結果かも決められない。コメントはレビュー画面で既に読める。
- ブランチ名での一致（`sourceVersion` が PR のソースブランチ）。ブランチの先端が
  進んだ後の古い結果を出してしまう。

### 状態

実行の状態をそのまま `status` に残し、次の `state` にまとめる。

| state | CodeBuild の buildStatus | CodePipeline の status |
|---|---|---|
| `pass` | `SUCCEEDED` | `Succeeded` |
| `fail` | `FAILED`、`FAULT`、`TIMED_OUT` | `Failed` |
| `pending` | `IN_PROGRESS` | `InProgress`、`Stopping` |
| `cancel` | `STOPPED` | `Stopped`、`Cancelled`、`Superseded` |
| `none` | 一致する実行がない | 同左 |
| `error` | 取得に失敗した（権限不足など） | 同左 |

知らない状態は `status` をそのまま残し、`state` を `pending` にする。

PR 全体の `state` は、各実行の `state` のうち、`fail`、`error`、`pending`、
`cancel`、`pass`、`none` の順で最初に現れるものにする。

### 表示する場所

| 場所 | 表示 |
|---|---|
| `pr view`（テキスト、`--json`） | 実行ごとに状態、名前、開始時刻、コンソール URL |
| `pr status`（テキスト、`--json`） | 同上 |
| レビュー画面 | ヘッダーに全体の状態を1行。詳細表示で実行ごとの行 |
| ホームの「自分の PR」と `lazycc status` | 全体の状態を1列 |

ホームの「承認待ち」には出さない。承認する側が CI を見るのはレビュー画面で足りる。
CI 結果は承認状態と同じく遅延取得し、取得に失敗しても PR の表示は止めない。

### --json

`ci` に対象リポジトリがないときは `"checks": null`。あるときは次の形。

```json
{
  "checks": {
    "state": "fail",
    "commit": "<sourceCommit>",
    "runs": [
      {
        "provider": "codebuild",
        "name": "my-service-pr-check",
        "state": "fail",
        "status": "FAILED",
        "id": "my-service-pr-check:0f3c...",
        "startedAt": "2026-11-15T10:00:00Z",
        "endedAt": "2026-11-15T10:04:12Z",
        "url": "https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/..."
      },
      {
        "provider": "codepipeline",
        "name": "my-service-release",
        "state": "none",
        "status": null,
        "id": null,
        "startedAt": null,
        "endedAt": null,
        "url": null
      }
    ]
  }
}
```

- `runs` は設定に書いた順に、プロジェクトとパイプラインごとに1件。
- `state` が `error` の実行は `message` に理由を持つ。
- ホームと `lazycc status` の「自分の PR」の行は `"checks"` に全体の `state`
  （文字列）か `null` を持つ。

### 依存

`@aws-sdk/client-codebuild` と `@aws-sdk/client-codepipeline` を足し、CI 結果を
読むときだけ動的 import する。ビルドで試したところ、2つのクライアントの
チャンクは合わせて約 120 KB で、CodeCommit のチャンクは変わらない
（SDK の共通部分は分離される）。起動時に読むファイルにも入らない。署名付きの
JSON リクエストを手で組む案は、依存は増えないが、再試行・認証チェーン・
エラー型を自前で持つことになるので採らない。

## Consequences

- CI 結果を見たい人は、設定ファイルに `ci` を書き、`codebuild:ListBuildsForProject`、
  `codebuild:BatchGetBuilds`、`codepipeline:ListPipelineExecutions` を許可する。
- 設定を書かない人の振る舞い、権限、起動時間は変わらない。
- PR のソースコミットをビルドしない構成（デフォルトブランチだけを見るパイプライン
  など）では、マージ前の PR は `none` になる。fast-forward でマージした PR は
  マージ後の実行と一致するが、squash と three-way では新しいコミットになるので
  一致しない。
- 直近 20 件より前の実行は見つからない。実行が多いプロジェクトでは、古い PR が
  `none` になる。
