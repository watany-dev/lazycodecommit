# AWS Emulator で試す

[AWS Emulator](https://github.com/aws/aws-emulator)（2026 年 11 月公開の AWS 公式の
ローカルエミュレータ）に lazycc を向けると、AWS アカウントなしで CLI と TUI を
一通り触れ、realcheck もほぼ全項目を回せる。ただし Emulator は本物の CodeCommit
と違うところがある。**Emulator で通ったことは実機確認ではない。** 実機の確認は
引き続き [real-aws-check.md](real-aws-check.md) で行う。

以下は Emulator の 2026-11-14 時点のソース（commit `813af480`）で確かめた。

## 起動する

AWS の手順（[Linux](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-linux.html)
は RPM / Debian パッケージ、macOS と Windows は
[Docker](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html)）
で入れ、テレメトリを切って起動する。

```bash
aws-emulator --telemetry off        # Docker なら docker run ... aws-emulator --telemetry off -p 9297
```

起動すると `~/.aws/emulator/9297/` に鍵（`emulator_credentials`）・自己署名の
証明書（`ca.pem`）・設定ができる。Docker の場合も AWS の手順どおり
`~/.aws/emulator` をマウントしておく。アカウントは `000000000000`、呼び出し元は
`user/emulator`。状態はメモリにしかなく、止めると消える。

## lazycc を向ける

```bash
eval "$(sh scripts/emulator/env.sh)"     # ポートが 9297 以外なら引数に渡す
```

`AWS_ENDPOINT_URL`・証明書・鍵を環境変数に入れ、git の転送を Emulator に向ける。
このシェルの中だけで効き、`~/.aws` や git のグローバル設定は変えない。

リポジトリは AWS CLI か SDK で作る（lazycc にはリポジトリを作るコマンドがない）。

```bash
aws codecommit create-repository --repository-name demo
lazycc clone demo --protocol grc      # https ではなく grc
cd demo && git switch -c main && git commit --allow-empty -m init && git push -u origin main
```

clone は `--protocol grc` にする。Emulator の `cloneUrlHttp` は
`http://127.0.0.1:<別のポート>/v1/repos/<repo>` で、lazycc はこれを CodeCommit の
リモートとして読まない（`core/remote.ts`）。`https` で clone すると clone はできるが、
その中で `-R` なしのコマンドがリポジトリを決められない。`env.sh` は
`git-remote-codecommit` を置き換えて grc の URL（`codecommit::us-east-1://demo`）を
Emulator に流すので、pip で入れる必要はない。

あとはいつもどおり `lazycc pr create`・`pr list`・`pr view`・`pr checkout`・
`lazycc`（ホーム）などが使える。自分の PR は承認できないので、承認を試すには
2 人目の IAM ユーザーを作ってその鍵のプロファイルで操作する（次の
`realcheck.sh` がやっている）。

## realcheck を回す

```bash
sh scripts/emulator/realcheck.sh            # realcheck のオプションを足せる（--keep など）
```

AWS CLI が要る。`env.sh` を読み込み、Emulator の中に 2 人目の IAM ユーザー
（`rc-other`）・ログアウト済みの SSO プロファイル・CodeBuild プロジェクトと
パイプライン（1 回ずつ実行）を用意して、`realcheck.mjs --emulator` を走らせる。
`--emulator` は clone を grc で行い、https・ssh の clone を SKIP にし、レポートに
Emulator 相手だと書く。

### 結果（2026-11-15）

PASS 69、DIFF 6、FAIL 1、SKIP 4。PASS になったのは、PR の作成・コメント・返信・
リアクション・承認と取り消し・マージ・クローズ、`clientRequestToken` での再投稿、
エラー名、browse、grc の clone と `pr checkout`、期限切れ SSO の案内、5 つの TUI
画面など。

PASS 以外は次のとおり。どれも Emulator の側か、実機でしか分からない項目で、
lazycc を直す根拠にはしない。

| 項目 | 結果 | 理由 |
| --- | --- | --- |
| `repo.cloneUrlHttp`・`repo.cloneUrlSsh` | DIFF | Emulator の URL は `127.0.0.1`。上の grc で回避 |
| `browse.shortRef`・`browse.short` | DIFF・FAIL | Emulator の `GetFolder` が 7 文字のコミット ID を受けない。実機でどうかは realcheck で確かめる項目 |
| `activity.self.reaction` | DIFF | Emulator ではリアクションで `lastActivityDate` が動かない。実機は未確認 |
| `ci.codebuild`・`ci.codepipeline` | DIFF | Emulator はビルドを実行せず FAILED にし、`resolvedSourceVersion`・`sourceRevisions` が空。lazycc はコミットと結び付けられないので、CI 欄に結果は出ない |
| `clone.https`・`clone.ssh` | SKIP | 上の URL の違いのため |
| `denied` | SKIP | Emulator は権限のない IAM ユーザーの CodeCommit 呼び出しを拒否しないので、`realcheck.sh` は `--limited-profile` を渡さない |

## 向いていること・向いていないこと

- 向いている: CodeCommit の API と git の転送を通した手元での動作確認、
  TUI を実データで触ること、realcheck のスクリプト自体を変えたときの通し確認。
- 向いていない: 実機との違いの確認（エラー文言、`lastActivityDate`、IAM の拒否、
  CI の結果）、CloudShell の Node での起動。これらは実機の realcheck で見る。
