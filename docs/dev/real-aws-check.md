# 実機確認（realcheck）

開発中の検証は、モックの CodeCommit と一時 git リポジトリで行ってきた。実際の
AWS でしか確かめられない点を、検証用のリポジトリ 1 つに対して一度に確かめるのが
`scripts/realcheck/realcheck.mjs` である。結果は 1 つの Markdown ファイルに
まとまるので、それを貼り返せば仕様や実装を直せる。

## 作るもの・消すもの

- 作る: CodeCommit リポジトリ `lazycc-realcheck-<日時>` を 1 つ。同じ名前が
  既にあれば何もせずに止まる。中にブランチ `main`・`feature/one`・`feature/two`
  と PR 2 本を作り、コメント・承認・マージ・クローズをする。
- 消す: 最後にそのリポジトリを削除する（`--keep` なら残す）。削除の前に名前が
  `lazycc-realcheck-` で始まり、この実行で作ったものであることを確かめる。
- 触らない: 既存のリポジトリ、`~/.config/lazycc` と `~/.local/state/lazycc`
  （作業ディレクトリ内の別の場所を使う）、git のグローバル設定（必要な設定は
  環境変数で渡す）。
- 実行前に作るもの・消すものを表示し、`yes` と入力するまで始めない。

途中で Ctrl+C しても、リポジトリを消してからそこまでのレポートを書いて終わる。
消せなかったとき（ネットワーク断、作成の再試行で作られたか分からないときなど）は
レポートと画面にリポジトリ名が出るので、
`aws codecommit delete-repository --repository-name lazycc-realcheck-…` で消す。

## 実行する

所要時間は 3〜5 分。未公開なので npm ではなく GitHub から clone してビルドする。

### CloudShell（推奨）

CloudShell の Node での起動と TUI も同時に確かめられる。ホーム（1 GB）ではなく
`/tmp` に置く（`node_modules` が約 270 MB。`/tmp` はセッション終了で消える）。

```bash
cd /tmp
git clone https://github.com/watany-dev/lazycodecommit.git
cd lazycodecommit
npx -y bun@1.4.4 install --frozen-lockfile
npx -y bun@1.4.4 run build
pip install --user git-remote-codecommit   # 任意: grc の clone も確かめる
node scripts/realcheck/realcheck.mjs --region ap-northeast-1
```

HTTPS の clone には、git に CodeCommit の credential helper が設定されていれば
それを使い（レポートには有無だけを書く）、なければこの実行の間だけ `aws codecommit credential-helper` を足す。

### 手元の clone

Bun が入っていれば `bun install && bun run build` のあと、同じく
`bun run realcheck -- --region <region> --profile <profile>`。SSO の期限切れの
確認は手元でしかできない（下記）。

### オプション

| オプション | 確かめられること |
| --- | --- |
| `--profile <name>` | 実行する identity（省略時は SDK の既定） |
| `--other-profile <name>` | 他人のコメント・承認で `lastActivityDate` が動くか、承認待ちに出るか（ADR 0005, 0006） |
| `--sso-expired-profile <name>` | `aws sso logout` 済みの SSO プロファイルで、サインインし直す案内が出るか |
| `--limited-profile <name>` | CodeCommit の権限がない identity で、拒否されたアクション名が出るか |
| `--ssh` | SSH の clone（IAM の SSH 公開鍵と `~/.ssh/config` の `User` が必要） |
| `--keep` | リポジトリと作業ディレクトリを残す（コンソールで見るときに使う） |
| `--no-redact` | レポートのアカウント ID を伏せない |

2 つ目の identity は、CloudShell なら同じアカウントのロールを引き受ける
プロファイルを `~/.aws/config` に書けば作れる。

```ini
[profile realcheck-other]
role_arn = arn:aws:iam::<ACCOUNT>:role/<CodeCommit を使えるロール>
credential_source = EcsContainer

[profile realcheck-limited]
role_arn = arn:aws:iam::<ACCOUNT>:role/<CodeCommit の権限がないロール>
credential_source = EcsContainer
```

## 結果を返す

終わるとカレントディレクトリに `lazycc-realcheck-<日時>.md` ができる。
CloudShell なら「アクション → ファイルのダウンロード」で取り出し、スレッドに
添付するか貼る。アカウント ID は `<ACCOUNT>` に置き換え済み。IAM のユーザー名や
ロール名は残る。

レポートの先頭に「Differences and failures」がある。

- **DIFF**: CodeCommit の応答が lazycc のコードの前提と違う（エラー名、応答の
  フィールド、`lastActivityDate` が動かない操作など）。ソースのどこの前提かを
  併記している。仕様か実装を直す対象。
- **FAIL**: lazycc 自身の不具合（終了コードや案内文が想定と違う）。
- PASS / SKIP / INFO はそのとおり。INFO は前提がなく記録だけするもの。

「Check by hand」の項目は自動では判定できないので、`--keep` で実行して
コンソールで開き、違っていたものを書き添える。

## 確かめる項目と出典

| 項目 | 出典 |
| --- | --- |
| コメント（インライン・返信）、リアクション、タイトル変更、push、他人のコメント・承認・取り消しで `lastActivityDate` が動くか | ADR 0006 |
| 他人から見て承認待ちに出るか、承認が ARN で記録されるか | ADR 0005 |
| `GetPullRequest` の応答に lazycc が読むフィールドがすべてあるか | `aws/codecommit.ts` toPullRequest |
| 自分の PR の承認、fast-forward できないとき、ソースが動いたときのエラー名と案内 | #12、`aws/errors.ts` |
| ファイルのパスへの `GetFolder`、存在しないファイル・ref・ブランチのエラー名 | #22、`core/browse.ts` |
| 7 文字のコミット ID を `GetFolder` / `GetCommit` が受けるか | #22、#23 |
| HTTPS・grc・SSH の clone と、その clone 内での `pr list` と `pr checkout` | #9、#10、#11 |
| 期限切れの SSO、権限不足での案内 | #7、`aws/errors.ts` |
| CloudShell の Node での npx 起動、起動時間（300 ms） | #2、#3、#7 |
| 各 TUI（レビュー、PR 一覧、ブランチ、ブラウズ、ホーム）が描画され q で終わるか | #10、#11、#22、#27 |
| clone URL が `core/remote.ts` の形にあうか、呼び出し元 ARN の形 | `core/remote.ts`、`core/inbox.ts` |
| 手で: コンソール URL（PR、browse、短い ID）、BEFORE 側インラインコメントの行、GovCloud・中国リージョンの URL | #8、#10、#22、#23 |

## モックで試す

`bun run build` のあと `bun run realcheck:mock`。`mock-server.mjs` は lazycc が
前提にしているとおりに答えるので、すべて PASS になる。実機のレポートとの違いが
そのままモック（と前提）との差になる。スクリプトを変えたらこれで確かめる。
