# ADR 0011: リポジトリ内のファイルで issue を持つ

## Status

Proposed. 仕様書の「やらないこと」のうち Issue を置き換える。

## Context

CodeCommit には issue がない。仕様書はそれを理由に Issue を「やらないこと」に
入れていたが、チームの作業の置き場として欲しいという要望が出た。CodeCommit の
外（Jira、GitHub など）に置く案はあるが、AWS アカウントの中で完結しない。

CodeCommit の API で確かめたことは次のとおり。

- `CreateCommit` は clone なしで、1 回の呼び出しで複数のファイルを足し、更新し、
  消したコミットを作れる。`parentCommitId` がブランチの先端と違うと
  `ParentCommitIdOutdatedException` で断る。つまり楽観ロックとして使える。
- `parentCommitId` は空のリポジトリ以外では必須で、API だけでは既存の履歴と
  つながらない（親のない）ブランチを作れない。
- `GetFolder` はフォルダの 1 階層を返し、サブフォルダには `treeId` が付く。
  `GetFile` は 1 ファイルを返す。どちらも既に `browse` が使っている。
- main（既定ブランチ）への push は、CodePipeline の変更検出の起点になりやすい。
  IAM の `codecommit:References` 条件で既定ブランチへの直接の書き込みを禁じる
  構成もよくある。承認ルールは PR にしか効かず、直接のコミットは止めない。

## Decision

### 置き場所

専用ブランチ（既定名 `issues`、設定 `issues.branch` で変える）の `issue/` に置く。

- 既定ブランチに置くと、issue を書くたびにパイプラインが走り、既定ブランチへの
  直接の書き込みを禁じたチームでは書けない。専用ブランチはどちらにも当たらない。
- ブランチがなければ、最初の `issue create` のときに既定ブランチの先端から
  `CreateBranch` で作る。コメントや close など番号を指す操作はブランチを作らず
  「その issue はない」で止める。番号の打ち間違いでブランチが残らないように
  するため。API では親のないブランチを作れないため、このブランチには作った時点の
  コードも入っているが、lazycc は `issue/` 以下しか読まない。親のないブランチに
  したい人は、先に git で作って push しておけば（`git switch --orphan issues`）
  そのまま使う。
- ブランチがないあいだ、読む操作は「issue はまだない」として空を返す。
- 空のリポジトリでは書かない。最初のコミットで issue のブランチができると、
  それがリポジトリの既定ブランチになってしまう。

採らなかった案: 既定ブランチに直接置く（上の理由）。コードと並んで見える利点は
あるが、設定で切り替える手段は必要になってから足す。

### 形式

1 issue を 1 フォルダにする。

```
issue/
  12/
    issue.md
    comments/
      20261121T051000Z-3f9a1c.md
```

`issue.md` は front matter と本文。

```markdown
---
title: ログイン画面が崩れる
state: open
author: arn:aws:iam::123456789012:user/watany
created: 2026-11-21T05:10:00Z
labels: bug, ui
---
本文（Markdown）
```

- front matter は `key: value` の行だけを読む最小のパーサにする。YAML の
  パーサは依存を増やすので入れない（ADR 0003 と同じ考え）。値は最初の `: ` の
  後ろ全部で、改行は入れられない（タイトルの改行は空白にする）。
- `state` は `open` か `closed`。閉じたときは `closed: <時刻>` を足す。
- 知らないキーは書き直しても残す。手で書いたファイルや、後の版の lazycc が
  足したキーを消さない。
- コメントは 1 件 1 ファイル（`<UTC の時刻>-<ランダムな 6 桁の 16 進>.md`）で、
  front matter に `author` と `created`、その後に本文。ファイル名の順に並べる。
  1 ファイルに追記する形は、同時にコメントすると同じファイルを奪い合うので
  採らない。
- 読めないファイル（front matter がない、`title` がない）は止めずに、
  パスと理由を添えて「読めない issue」として出す。

ファイルはただの Markdown なので、clone して手で書いても、コンソールで読んでも
よい。lazycc はそれを読む。

### 番号

`issue/` の下の数字だけのフォルダ名の最大値 + 1。数字でないフォルダは無視する。

### 書き込み

読んだ先端のコミットを `parentCommitId` に渡して `CreateCommit` する。
`ParentCommitIdOutdatedException` なら先端から読み直して作り直し、3 回まで
試す。同時に issue を作って番号がぶつかっても、同時に閉じてコメントしても、
後の側が読み直すので上書きしない。

SDK は応答が来ないと同じ `CreateCommit` を送り直す。最初の呼び出しが届いていれば
送り直しは `ParentCommitIdOutdatedException` になり、読み直すと自分のコミットが
既にある。同じ issue やコメントを二重に作らないよう、読み直した先端に自分の
変更（前回試した番号で作成時刻と作成者が同じ issue、同じパスのコメント）が
あれば、書かずに終える。

コミットメッセージは `issue #12: <動作>`（`create`、`comment`、`close`、
`reopen`）。

### 操作

| コマンド | 動作 |
|---|---|
| `lazycc issue list` | `--state open\|closed\|all`（既定 open）、`-L`（既定 30）。番号の新しい順 |
| `lazycc issue view <n>` | issue とコメントを出す |
| `lazycc issue create` | `-t title`、`-b body` / `-F file`、`-l label`（複数可）。title がなく端末なら エディタで書く |
| `lazycc issue comment <n>` | `-b body` / `-F file`。なければエディタ |
| `lazycc issue close <n>` / `reopen <n>` | `state` を書き換える |

どれも `--json` を持つ。clone の外でも `--repo` で使える。TUI はホームから
issue 一覧と詳細の画面に入れるようにする（CLI の後に足す）。

### 読む量

一覧は `GetFolder`（`issue/`）1 回と、issue ごとの `GetFile`（`issue.md`）。
issue の数に比例する。フォルダの `treeId` が変わらなければ中身も変わらないので、
数が増えて遅くなったら、`treeId` を鍵にローカルにキャッシュする。最初の版では
入れない。

## Consequences

- 仕様書の「やらないこと」から Issue を外す。
- 書き込むには `CreateCommit`、`GetBranch`、`GetRepository`（ブランチを作るとき
  の既定ブランチ）、`CreateBranch`（最初の 1 回）が要る。読むのは `GetFolder`、
  `GetFile`、`GetBranch`。
- 担当者、マイルストーン、通知、全文検索はない。必要なら front matter に
  キーを足して広げる。
- issue の履歴は `issues` ブランチの git の履歴そのもので、誰がいつ何をしたかは
  コミットに残る。消した issue も履歴からは消えない。
- `issues` ブランチから誤って PR を作ると、作った時点のコードとの差分が出る。
