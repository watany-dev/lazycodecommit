# ADR 0003: 設定ファイル形式

## Status

Accepted.

## Context

仕様書は、依存なしで読める JSON を仮に置き、手書きしやすい TOML にするかを
未決にしていた。設計原則は「依存を増やさない」。

Node.js の標準ライブラリには TOML パーサがない。Bun には組み込みの TOML
読み込みがあるが、実行環境は Node.js である（ADR 0002）。

## Decision

設定ファイルは JSON（`~/.config/ccm/config.json`、`XDG_CONFIG_HOME` に従う）。

## Consequences

- 追加の依存なしで `JSON.parse` で読める。
- コメントは書けない。キーは少なく、設定なしで動く（仕様書）ので、手書きの負担は小さい。
- 読めない JSON や型の合わない値は、ファイルパスと位置を示して終了コード 1 で止める。
  ローカル状態ファイルと違い、設定は利用者が書いたものなので黙って捨てない。
