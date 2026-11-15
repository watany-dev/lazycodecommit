# ADR 0002: 言語と実行環境

## Status

Accepted.

## Context

仕様書は TypeScript と Ink の継続を前提にし、CLI のコールドスタートが目標
（API 待ちを除いて 300ms 以内）に届かない場合は Go へ移すかを未決にしていた。

CloudShell の計算資源は 1 vCPU、2 GiB RAM、永続ストレージ 1 GB
（[AWS ドキュメント](https://docs.aws.amazon.com/cloudshell/latest/userguide/vm-specs.html)）。
同梱の Node.js のバージョンはドキュメントに書かれていない。2024 年 12 月時点では
v20.18.0 だった。Node.js 20 は 2026 年 4 月にサポートが終わっている。

現行の review-codecommit は、Bun で `src/cli.tsx` を ESM の 1 ファイル
（`dist/cli.mjs`）に束ね、`dependencies` を空にして公開している。実行は Node.js。

### 起動時間の計測

review-codecommit と同じ方法で、`@aws-sdk/client-codecommit` と
`@aws-sdk/client-sts` のクライアントとコマンドを生成するだけの CLI を
`bun build --target node --format esm --minify` で束ねた（687 KB）。
Node.js 22.23、`taskset -c 0` で 1 CPU に固定し、15 回起動した。

| 対象 | 中央値 | 最大 |
|---|---|---|
| 空のスクリプト | 34 ms | 42 ms |
| 試作 CLI | 108 ms | 122 ms |

目標の 300ms に対して約 3 倍の余裕がある。`npx` 自体の解決時間はこの値に
含まない（初回はダウンロード、2 回目以降はキャッシュから起動する）。

## Decision

- 言語は TypeScript を継続し、Go には移さない。
- TUI は Ink、AWS は AWS SDK for JavaScript v3（`client-codecommit`、`client-sts`）。
- 開発は Bun（パッケージ管理、ビルド）、Vitest、oxlint。現行と同じ。
- 公開物は Bun で束ねた ESM の 1 ファイルとし、`dependencies` は空にする。
  CloudShell の `npx` でインストールする依存をなくすため。
- 実行は Node.js。Bun を実行時の必須にしない。
- Ink と React は TUI を開くときだけ動的 import する（仕様書の非機能要件）。
- Node.js の下限（`engines`）は暫定で `>=20` とし、CI は 20、22、24、26 で試験する。
  CloudShell の実際のバージョンを確認したら、22 以上なら `>=22` に上げ、CI の
  マトリクスの先頭もそろえる。

## Consequences

- review-codecommit のレビュー画面と API 呼び出しを移植できる。
- CI では束ねた成果物を Node.js で起動するテストを置き、起動時間の回帰を検出する。
- 起動時間が目標を超えたときは、まず import の分割と遅延読み込みで対処する。
  言語の変更はそれでも届かないときに改めて検討する。
