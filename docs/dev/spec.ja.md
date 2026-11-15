# review-codecommit 後継クライアント 仕様書

2026-11-15 · watany

> 元は claude.ai 上の仕様書ドキュメント（https://claude.ai/artifact/6vXwWFvrA1ACid3FsUJxph ）。リポジトリに取り込んだ時点から、このファイルを正とする。画面遷移図は取り込めなかったため、文章の説明だけを残している。未決事項の結論は末尾の「決定事項」と `docs/adr/` にある。

## 背景と目的

レビュー以外の用事でも開く「CodeCommit の日常クライアント」に作り直し、コンソールを開く回数を減らす。

現行の review-codecommit (https://github.com/watany-dev/review-codecommit) はレビュー機能(diff、インラインコメント、承認、マージ)が揃っている。しかし入口が「リポジトリ選択 → PR 一覧」の1本しかなく、PR 作成、コード閲覧、ブランチ確認のたびにコンソールを開いている。

新クライアントは次の3点を満たす。
- PR 作成、ブランチ確認、コード閲覧がターミナル内で完結する。
- gh のようにサブコマンドで呼べて、引数なしでは lazygit のような TUI が開く。
- CloudShell でそのまま動くコンパクトさを保つ。

## 設計原則

git が知らないことだけを扱い、git でできることは git に任せる。
- CodeCommit 固有の情報を対象にする。 PR、承認、コメント、リポジトリ横断の状況、clone していないリモートの中身を扱う。
- git を再実装しない。 push、fetch、checkout、diff、log は内部で git コマンドを呼ぶ。
- clone の有無で振る舞いを変える。 clone 内では git を優先し、clone 外では API にフォールバックする。
- 全機能にコマンドの入口を持たせる。 TUI でできる操作はサブコマンドでも呼べて、--json で機械可読にする。
- 小さく保つ。 依存を増やさず、CloudShell で追加セットアップなしに起動できる。

## スコープ

対象は PR 作成、ブランチ確認、コード閲覧、横断の受信箱、レビューの5機能に絞る。

### やること
| 機能 | 内容 | git との分担 |
|---|---|---|
| PR 作成 | 現在のブランチから PR を作る | push とコミット一覧の取得は git |
| ブランチ×PR 対応表 | どのブランチに PR があるかを一覧する | ahead/behind と最終コミットは git |
| ホーム(受信箱) | 承認待ちと自分の PR をリポジトリ横断で出す | git は使わない |
| clone なしブラウズ | リモートのツリーとファイルを読む | clone 内ではエディタに任せる |
| レビュー | 現行機能を引き継ぐ | clone 内の diff は git |
| checkout と clone の補助 | PR ID やリポジトリ名から git を呼ぶ | 実処理はすべて git |

### やらないこと
| 項目 | 代わりの手段 |
|---|---|
| ステージング、コミット、rebase | git、lazygit |
| コミットログ、タグ、任意 ref の比較 | git log、git diff |
| blame、全文検索、ファイル履歴 | clone して git とエディタ |
| Issue、Release | CodeCommit に存在しない |
| 承認ルールテンプレート、トリガーなどのリポジトリ設定 | コンソール、IaC |

## コマンド体系

サブコマンドは gh に合わせた「名詞 動詞」形式にし、引数なしで TUI を開く。コマンド名は lazycc、npm パッケージ名は lazycodecommit とする(ADR 0001)。
| コマンド | 動作 | clone 外での利用 |
|---|---|---|
| lazycc | ホーム(受信箱)の TUI を開く | 可 |
| lazycc status | ホームと同じ内容をテキストで出す | 可 |
| lazycc pr create | 現在のブランチから PR を作る | --repo と --head の指定で可 |
| lazycc pr list | PR 一覧を出す。--state open\|closed(既定 open)、-L, --limit(既定 30) | 可 |
| lazycc pr view [id] | PR を開く。ID 省略時は現在のブランチの PR | ID 指定で可 |
| lazycc pr status | 現在のブランチの PR の承認とコンフリクトの状況を出す。PR がなければその旨を出して終了コード 0 | 不可 |
| lazycc pr checkout <id> | PR のソースブランチを fetch して切り替える | 不可 |
| lazycc pr comment [id] | PR にコメントする。本文は -b、-F、端末ではエディタ。閉じた PR にもコメントできる | ID 指定で可 |
| lazycc pr approve [id] | 承認する。--revoke で取り消す | ID 指定で可 |
| lazycc pr merge [id] | マージする。方式は --ff、--squash、--three-way のどれか1つを必ず指定する。読んだ後にソースブランチが進んでいたら拒否する | ID 指定で可 |
| lazycc pr close [id] | マージせずに閉じる | ID 指定で可 |
| lazycc branch | ブランチ×PR 対応表を開く | 可 |
| lazycc browse [repo] | clone なしでコードを読む | 可 |
| lazycc clone <repo> | リポジトリ名から URL を解決して git clone する | 可 |
| lazycc completion <shell> | bash、zsh、fish の補完スクリプトを出す | 可 |

### 共通フラグ
| フラグ | 意味 |
|---|---|
| -R, --repo <name> | 対象リポジトリを明示する |
| --profile <name> | AWS プロファイルを指定する |
| --region <region> | リージョンを指定する |
| --json | JSON で出力する |

### 出力と終了コード
- 端末(TTY)では TUI または色付きテキストを出す。
- パイプ先や --json 指定時は TUI を開かず、テキストか JSON を出す。
- 終了コードは 0 が成功、1 が実行時エラー、2 が引数の誤り。
- pr comment、approve、merge、close の ID 省略時は、pr view と同じく現在のブランチの PR を対象にする。approve、merge、close はマージ済みや閉じた PR には API を呼ばずに終了コード 1 で断る。

### リポジトリの推定

対象リポジトリは次の順で決める。
- --repo の指定。
- カレントディレクトリの git remote origin の URL。
- どちらもなければ、TUI ではリポジトリ選択を開き、非 TTY ではエラーにする。

remote URL は次の3形式を解釈し、リージョンとプロファイルも取り出す。
| 形式 | 例 |
|---|---|
| HTTPS | https://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my-repo |
| SSH | ssh://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my-repo |
| git-remote-codecommit | codecommit::ap-northeast-1://profile@my-repo |

--repo や --region が origin と別のリポジトリ(名前かリージョンが違う)を指すときは、clone 外として扱う。同じ名前でもリージョンが違えば別のリポジトリなので、origin への push やローカルのコミットからの下書きは行わない。

## PR 作成

lazycc pr create は、clone 内なら引数なしで push から PR 作成まで終える。

### 手順
- 現在のブランチを取得する。detached HEAD ならエラーにする。
- ベースブランチを決める。--base がなければリポジトリのデフォルトブランチを使う。
- 同じソースとベースの OPEN な PR が既にあれば、その PR を表示して終了する。
- git log <base>..HEAD からタイトルと本文の下書きを作る。
- コミットが1件なら、件名をタイトルに、コミット本文を PR 本文にする。
- 複数件なら、ブランチ名を整形してタイトルにし、コミット件名を箇条書きで本文に入れる。
- テンプレートファイルがあれば本文の末尾に差し込む。
- $EDITOR で下書きを開く。1行目がタイトル、空行の後が本文。タイトルが空なら中止する。
- origin に同名のブランチがないか、origin/<branch> にないコミットがあれば、確認のうえ git push -u origin <branch> を実行する。upstream ではなく origin/<branch> と比べるのは、PR のソースが同名のリモートブランチだから。エディタの後に置くのは、エディタで中止したときに何も push しないため。
- CreatePullRequest を呼ぶ。SDK の再試行で二重作成しないよう clientRequestToken を付ける。
- PR ID、タイトル、コンソール URL を出力する。

TUI のブランチ表から作成した場合は、作成後にそのままレビュー画面を開く。

### フラグ
| フラグ | 意味 |
|---|---|
| -B, --base <branch> | ベースブランチを指定する |
| -H, --head <branch> | ソースブランチを指定する。clone 外では必須 |
| -t, --title <text> | タイトルを指定する |
| -b, --body <text> | 本文を指定する |
| -F, --body-file <path> | 本文をファイルから読む |
| --fill | 下書きをそのまま使い、エディタを開かない |
| --push | 確認なしで push する |
| --no-push | push が必要なら失敗させる |
| --dry-run | push と CreatePullRequest を行わず、作成内容だけ表示する。ベースの解決と既存 PR の確認のための参照系 API は呼ぶ |

--title と --body の両方を指定した場合もエディタを開かない。非 TTY でエディタが必要になる指定(--fill も --title と --body の組もない)は、引数の誤り(終了コード 2)にする。

--json 指定時、作成した PR は pr view --json と同じ形で出す。既存 PR があるときは同じ形に "existing": true を足して標準出力に出し、終了コード 1 で終わる。

### エラー時の挙動
| 状況 | 挙動 |
|---|---|
| 現在のブランチがベースと同じ | エラーにし、作業ブランチへの切り替えを促す |
| ベースとの差分コミットが 0 件 | エラーにする |
| 同じ組み合わせの OPEN な PR がある | 既存 PR の ID と URL を表示し、終了コード 1 で終わる |
| push に失敗した | git のエラーをそのまま表示して中止する |
| 非 TTY で push が必要だが --push がない | エラーにする |
| 認証情報が期限切れ | aws sso login などの再認証を案内する |

### 補足
- テンプレートの既定パスは .codecommit/pull_request_template.md。設定で変更できる。
- clone 外では push とコミットからの下書きを行わず、タイトルの初期値はブランチ名にする。ソースブランチがリモートにあることは GetBranch で確かめる。
- clientRequestToken は実行ごとに新しく作る。再実行での二重作成は既存 PR の確認で防ぐ。内容から作ると、その後に閉じた PR が返ってきてしまう。
- clone 内では、ベースとの差分を origin/<base> から取る。なければローカルの <base>、どちらもなければ git fetch を案内する。
- コンソール URL は https://<region>.console.aws.amazon.com/codesuite/codecommit/repositories/<repo>/pull-requests/<id>/details?region=<region> の形式で組み立てる。

## ブランチ×PR 対応表

lazycc branch は、各ブランチに PR があるか、消してよいかを1画面で示す。

### 表示項目
| 列 | 内容 | 取得元 |
|---|---|---|
| ブランチ名 | デフォルトブランチには印を付ける | ListBranches、GetRepository |
| 状態 | PR あり、マージ済み、PR なしのいずれか | PR 情報から判定 |
| PR | ID、タイトル、承認ルールの充足 | GetPullRequest、EvaluatePullRequestApprovalRules |
| ahead/behind | デフォルトブランチとの差 | git rev-list --left-right --count(clone 内のみ) |
| 最終コミット | 日時と作者 | git for-each-ref(clone 内のみ) |

clone 内ではリモート追跡ブランチの情報を使う。Ctrl+r で git fetch origin と PR 情報の再取得を行う。

### 状態の判定
| 状態 | 条件 |
|---|---|
| PR あり | そのブランチをソースとする OPEN の PR がある |
| マージ済み | OPEN の PR がなく、マージされた PR のソースコミットがブランチ先端と一致する |
| PR なし | 上記以外 |

- マージ済みの判定は PR 情報で行う。squash マージは git branch --merged で検出できないため。
- CLOSED の PR は直近 100 件まで調べる(設定で変更可)。
- マージ後にコミットが積まれたブランチは「PR なし」に戻る。

### 操作
| キー | 動作 |
|---|---|
| Enter | PR ありの行でレビュー画面を開く |
| n | PR なしの行で PR 作成に進む |
| d | リモートブランチを削除する(確認あり) |
| Space | そのブランチに切り替える(clone 内のみ、git switch を呼ぶ) |
| / | ブランチ名で絞り込む |

- 削除は DeleteBranch API で行い、ローカルブランチには触れない。
- デフォルトブランチと、OPEN の PR があるブランチは削除できない。
- 非 TTY や --json 指定時は、同じ表をテキストか JSON で出す。

## ホーム(受信箱)

引数なしの lazycc は、監視対象リポジトリを横断して「自分が動くべき PR」を先頭に出す。

### 区分
| 区分 | 条件 | 表示項目 |
|---|---|---|
| 承認待ち | 他人が作った OPEN の PR で、自分がまだ承認していない | リポジトリ、ID、タイトル、作成者、最終更新 |
| 自分の PR | 自分が作った OPEN の PR | リポジトリ、ID、タイトル、承認ルールの充足、コンフリクト有無、最終更新 |

- 「自分」は sts:GetCallerIdentity の ARN で判定し、PR の作成者 ARN や承認者 ARN と照合する。
- CodeCommit にはレビュアー指名がないため、承認待ちは上の簡易条件で代用する(未決事項)。

### 未読
- CodeCommit には通知も未読もないため、PR ごとの最終閲覧時刻をローカルに保存する。
- PR の lastActivityDate が最終閲覧時刻より新しければ、未読の印を付ける。
- レビュー画面を開いた時点で既読にする。

### 監視対象
- 設定ファイルの repos に列挙したリポジトリを対象にする。
- 未設定なら、clone 内ではそのリポジトリだけを対象にし、clone 外ではリポジトリ選択を開く。
- リポジトリ選択画面の w で、監視対象への追加と解除ができる。

### 取得とキャッシュ
- ListPullRequests は ID しか返さないため、GetPullRequest を並列(既定 8)で呼ぶ。
- 前回の結果をディスクにキャッシュし、起動直後はキャッシュを表示して裏で更新する。
- 承認状態、承認ルールの評価、コンフリクト確認は PR ごとに追加の呼び出しが要るため、一覧表示後に遅延取得する。
- lazycc status は同じ内容をテキストで出し、--json に対応する。

## clone なしブラウズ

lazycc browse は、clone していないリポジトリのツリーとファイルを API だけで読む。主な用途は CloudShell と、手元にないリポジトリの確認。

### 範囲
| 機能 | 内容 | API |
|---|---|---|
| ツリー表示 | フォルダを開いた時点で、その階層だけ取得する | GetFolder |
| ファイル表示 | 行番号つきで表示する。バイナリは表示しない | GetFile |
| ref 切り替え | ブランチ一覧から選ぶか、コミット ID を入力する | ListBranches |
| 絞り込み | 開いているフォルダ内を名前で絞る | なし(取得済みの結果を使う) |
| URL 表示 | 開いている場所のコンソール URL を出す | なし |

### 起動
- lazycc browse は、clone 内ではそのリポジトリを、clone 外ではリポジトリ選択を開く。
- lazycc browse my-repo --ref develop --path src/ で開始位置を指定できる。
- --ref を省略すると既定ブランチを開く。--path が `/` で終わるときはフォルダとしてだけ探し、そうでなければフォルダがなければ同名のファイルを開く。
- 端末でないときと --json のときは TUI を開かない。フォルダなら `ls -F` と同じ形の一覧を、ファイルなら中身を標準出力に出す（制御文字は他の出力と同じくキャレット表記になる）。バイナリと API のサイズ上限を超えるファイルは出さず、理由とコンソール URL を出して終了コード 1 にする。--json では binary か tooLarge を立て、content を null にして終了コード 0 にする。

### 作らないもの
- blame、ファイル履歴、全文検索は作らない。必要なら lazycc clone で手元に落とす。
- API のサイズ上限を超えるファイルは表示せず、clone を案内する。
- git タグの一覧を返す API がないため、ref の選択肢にタグは出さない。
- clone 内でも動くが、表示するのはリモートの状態。作業ツリーの閲覧はエディタに任せる。

## レビュー画面

現行 review-codecommit のレビュー機能とキーバインドをそのまま引き継ぎ、入口と diff の取得元だけを変える。

### 引き継ぐ機能
- 行番号つきの色分け unified diff と、コミット単位の表示切り替え。
- コメントの閲覧、投稿、インラインコメント、返信、編集、削除、折りたたみ、リアクション。
- 承認と取り消し、承認ルール評価の表示。
- マージ(Fast-forward、Squash、Three-way)、コンフリクト検出、クローズ。
- アクティビティのタイムライン。

### 変更点
| 項目 | 現行 | 新 |
|---|---|---|
| 入口 | リポジトリ選択 → PR 一覧 | ホーム、ブランチ表、lazycc pr view、PR 作成直後 |
| diff の取得 | API | clone 内は git、clone 外は API |
| 既読管理 | なし | 開いた時点で最終閲覧時刻を更新する |
| PR 一覧画面 | 起動時の主画面 | lazycc pr list とリポジトリ選択から開く副画面 |

### clone 内の diff
- ソースとベースのコミットがローカルになければ git fetch origin <source> <destination> を実行する。
- git diff <mergeBase>..<sourceCommit> の出力を表示に使う。
- fetch に失敗した場合は API にフォールバックする。

インラインコメントの位置は、取得元にかかわらず CodeCommit の filePath、filePosition、relativeFileVersion(BEFORE / AFTER)に対応させる。

## 画面遷移とキーバインド

トップレベルはホーム、ブランチ表、ブラウズの3ビューで、レビュー画面はホームとブランチ表から降りる先にある。

ブランチ表からは、PR のある行は直接レビューへ、PR のない行は PR 作成を経てレビューへ進む。

### 全画面共通
| キー | 動作 |
|---|---|
| j / k、↓ / ↑ | カーソルを動かす |
| q / Esc | 1つ戻る。トップレベルでは終了する |
| Ctrl+c | 即時終了する |
| ? | ヘルプを出す |

### トップレベル3ビュー共通
| キー | 動作 |
|---|---|
| 1 / 2 / 3 | ホーム、ブランチ表、ブラウズに切り替える |
| r | リポジトリ選択を開く |
| Ctrl+r | 再取得する |
| / | 絞り込む |
| u | コンソール URL を表示する |

### ホーム
| キー | 動作 |
|---|---|
| Tab | 承認待ちと自分の PR を切り替える |
| Enter | レビュー画面を開く |

ブランチ表のキーは「ブランチ×PR 対応表」の操作を参照。

### ブラウズ
| キー | 動作 |
|---|---|
| Enter / l | フォルダまたはファイルを開く |
| h / Backspace | 親フォルダに戻る |
| b | ref を切り替える |
| Ctrl+d / Ctrl+u | ファイル表示で半ページ動かす |
| g / G | 先頭、末尾に移動する |

### リポジトリ選択
| キー | 動作 |
|---|---|
| Enter | そのリポジトリに切り替える |
| w | 監視対象に追加、または解除する |
| p | そのリポジトリの PR 一覧画面を開く |

### レビュー画面

現行のキーをそのまま使う。主なものは c コメント、C インラインコメント、R 返信、a 承認、r 承認取り消し、m マージ、x クローズ、]c / [c 変更箇所への移動。

トップレベル用のキー(1〜3、r、u)はレビュー画面では無効にする。これにより r などの衝突を避ける。

## 設定・認証・ローカル状態

設定なしで動き、必要なときだけ設定ファイルを置く。

### 設定ファイル

場所は ~/.config/lazycc/config.json(XDG_CONFIG_HOME に従う)。

```json
{
  "profile": "dev",
  "region": "ap-northeast-1",
  "repos": ["my-service", "my-infra"],
  "pr": {
    "template": ".codecommit/pull_request_template.md",
    "mergeOption": "squash"
  },
  "branch": { "closedPrLookback": 100 },
  "concurrency": 8
}
```

### プロファイルとリージョンの優先順位
- --profile、--region フラグ。
- clone 内では git remote URL から読み取った値。
- 環境変数 AWS_PROFILE、AWS_REGION。
- 設定ファイル。
- AWS SDK の既定値。

remote URL を環境変数より優先するのは、リポジトリのリージョンがシェルの既定リージョンと違う場合に取り違えないため。

### 認証
- AWS SDK の既定の認証チェーンを使う。CloudShell では追加設定なしで動く。
- 自分の ARN は sts:GetCallerIdentity で取得し、プロファイルごとにキャッシュする。
- 認証切れは API エラーから検出し、再認証のコマンドを案内する。

### ローカル状態

場所は ~/.local/state/lazycc/(XDG_STATE_HOME に従う)。
| ファイル | 内容 |
|---|---|
| seen.json | PR ごとの最終閲覧時刻 |
| cache.json | ホームとブランチ表の前回取得結果 |
| identity.json | プロファイルごとの ARN |

- 状態ファイルが壊れていても起動を止めず、破棄して作り直す。
- CloudShell ではホームディレクトリがリージョン単位で永続化されるため、未読状態はセッションをまたいで残る。

## 技術構成

TypeScript と Ink を継続し、CLI と TUI が同じコア層を共有する構成にする。

### 採用技術
| 項目 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript | 現行のレビュー画面と API 呼び出しを移植できる |
| TUI | Ink | 同上 |
| AWS | AWS SDK v3(client-codecommit、client-sts) | 同上 |
| git | git コマンドを子プロセスで呼ぶ | 再実装しない原則に従い、git ライブラリの依存を持たない |
| 開発 | Bun、Vitest、oxlint | 現行と同じ |
| 配布 | npm パッケージ(npx で起動) | CloudShell にインストールなしで入る |

### モジュール分割
| 層 | 責務 |
|---|---|
| cli/ | 引数解析、テキストと JSON の出力、終了コード |
| tui/ | Ink の画面(ホーム、ブランチ表、ブラウズ、レビュー、リポジトリ選択) |
| core/ | 受信箱の組み立て、ブランチ状態の判定、PR 下書きの生成 |
| aws/ | CodeCommit と STS の呼び出し、ページング、並列取得 |
| git/ | git コマンドの実行。git を呼ぶのはこの層だけ |
| state/ | 設定、キャッシュ、既読の読み書き |

依存の向きは cli/ と tui/ から core/ へ、core/ から aws/、git/、state/ への一方向にする。

### git 層が呼ぶコマンド
| 用途 | コマンド |
|---|---|
| 現在のブランチ | git symbolic-ref --short HEAD |
| remote URL | git remote get-url origin |
| 未 push の確認 | git rev-list --count origin/<branch>..<branch> |
| push | git push -u origin <branch> |
| コミット一覧 | git log --reverse <base>..HEAD |
| ahead/behind | git rev-list --left-right --count origin/<default>...origin/<branch> |
| ブランチ情報 | git for-each-ref refs/remotes/origin |
| diff | git diff <mergeBase>..<sourceCommit> |
| fetch | git fetch origin [<ref>...] |
| 切り替え | git switch <branch> |
| clone | git clone <url> |

### 非機能要件
- CLI サブコマンドは Ink と React を読み込まない。TUI を開くときだけ遅延 import する。
- CLI のコールドスタートは、API 待ちを除いて 300ms 以内を目標にする。
- CloudShell 同梱の Node.js で npx 起動できること。Bun を必須にしない。
- API のスロットリングは SDK の再試行に任せ、並列数は設定値で抑える。
- テストは aws/ を SDK のモックで、git/ を一時リポジトリで検証する。
- 他人が書いたテキスト(PR のタイトルと本文、コメント、コミットメッセージ、ファイルの中身)は、制御文字をキャレット表記(^[ など)にしてから端末に出す。エスケープシーケンスで画面やクリップボードを書き換えられないようにするため。ファイルパスのように API へ送り返す識別子は変えない。
- 外から来る入力(remote URL、設定ファイル、コミットメッセージ、PR のタイトルと本文)を扱う処理と、フラグの組み合わせで分岐する処理は、fast-check のプロパティテスト(*.prop.test.ts)で入力を生成して確かめる。入力の組み合わせが有限で小さいもの(リポジトリの推定)は全組み合わせを仕様と突き合わせる。

## IAM 権限

閲覧だけなら参照系アクションで動き、書き込みは機能ごとに分かれる。アクション名は codecommit: を省略している。
| 機能 | 必要なアクション |
|---|---|
| ホーム、PR 一覧 | ListRepositories、ListPullRequests、GetPullRequest、GetPullRequestApprovalStates、EvaluatePullRequestApprovalRules、GetMergeConflicts |
| PR 作成 | GetRepository、ListPullRequests、GetPullRequest、GetBranch(clone 外のみ)、CreatePullRequest、GitPush |
| ブランチ表 | ListBranches、GetBranch、GetRepository、DeleteBranch(削除時のみ) |
| ブラウズ | GetFolder、GetFile、ListBranches、GetRepository(--ref 省略時) |
| レビュー(閲覧) | GetCommit、GetDifferences、GetBlob、GetCommentsForPullRequest、GetCommentReactions、DescribePullRequestEvents |
| レビュー(書き込み) | PostCommentForPullRequest、PostCommentReply、UpdateComment、DeleteCommentContent、PutCommentReaction、UpdatePullRequestApprovalState、UpdatePullRequestStatus、MergePullRequestByFastForward、MergePullRequestBySquash、MergePullRequestByThreeWay |
| checkout、clone、fetch | GitPull |

- sts:GetCallerIdentity は権限の付与なしで呼べる。
- 権限不足のエラーでは、不足しているアクション名を表示する。

## 実装フェーズ

最優先の PR 作成を TUI なしで先に出し、現行ツールと並行して使い始める。
| フェーズ | 範囲 | 完了条件 |
|---|---|---|
| 1. CLI 基盤と PR 作成 | リポジトリ推定、設定、git/ 層、pr create、pr list、pr view(テキスト)、pr status、--json | clone 内で lazycc pr create --fill --push がコンソールなしで完結する |
| 2. TUI とブランチ表 | TUI の枠組み、レビュー画面の移植、branch、pr checkout、clone | ブランチ表から PR 作成とレビューに進める。現行のレビュー機能がすべて動く |
| 3. ホーム | 横断取得、キャッシュ、既読、status、リポジトリ選択と監視対象 | 承認待ちと自分の PR の確認が lazycc の起動だけで済む |
| 4. ブラウズと残りの CLI | browse、pr comment、pr approve、pr merge、pr close、シェル補完 | CloudShell で clone なしにコードを読める |

## 決定事項

仕様書の初版で未決だった8つの論点の結論。詳細と根拠は各 ADR にある。

| 論点 | 結論 | ADR |
|---|---|---|
| コマンド名とパッケージ名 | コマンドは `lazycc`、npm パッケージは `lazycodecommit` | [0001](../adr/0001-command-and-package-name.md) |
| 言語 | TypeScript を継続し、Go には移さない | [0002](../adr/0002-language-and-runtime.md) |
| 設定ファイル形式 | JSON | [0003](../adr/0003-config-format.md) |
| PR テンプレートの置き場所 | `.codecommit/pull_request_template.md` を既定にし、設定で変更できる | [0004](../adr/0004-pr-template-location.md) |
| 承認待ちの定義 | 簡易条件に、承認プールに自分が入っているかの条件を足す | [0005](../adr/0005-awaiting-my-approval.md) |
| 未読判定の検証 | フェーズ3の完了条件として実機で確認する | [0006](../adr/0006-unread-detection.md) |
| CI 結果の表示 | フェーズ1〜4に入れない | [0007](../adr/0007-out-of-phase-features.md) |
| コメントの下書き一括投稿 | フェーズ1〜4に入れない | [0007](../adr/0007-out-of-phase-features.md) |
