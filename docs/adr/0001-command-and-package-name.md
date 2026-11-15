# ADR 0001: コマンド名とパッケージ名

## Status

Proposed（watany の判断待ち）。

## Context

仕様書はコマンド名を仮に `ccm` とした。`cc` は C コンパイラと衝突するため避けている。
配布は npm パッケージで、CloudShell では `npx` で起動する（ADR 0002）。

2026-11-15 時点の npm レジストリ:

| 名前 | 状態 |
|---|---|
| `lazycodecommit` | 空き |
| `lazy-codecommit` | 空き |
| `review-codecommit` | watany が公開済み（0.1.3） |
| `ccm` | 別のパッケージが使用中（2.2.0、2022 年更新） |
| `lazycc` | 別のパッケージが使用中（2026 年更新） |
| `lcc` | 別のパッケージが使用中。LCC という C コンパイラとも衝突する |

`npx <名前>` は、その名前のパッケージを取得して実行する。`npm exec` は、
パッケージの bin が 1 つならそれを、複数ならパッケージ名と同じ名前の bin を実行する。

## Decision（推奨案）

- パッケージ名は `lazycodecommit` にする。リポジトリ名と同じで、npm で空いている。
- bin は `lazycodecommit` と `ccm` の 2 つを持つ。
  - `npx lazycodecommit` はパッケージ名と同じ bin を実行するので、CloudShell で
    インストールなしに起動できる。
  - グローバルにインストールした後は、短い `ccm` で呼べる。
- ドキュメントでは `npx ccm` を案内しない。npm の `ccm` は別のパッケージのため。

## Consequences

- 仕様書とヘルプの例は `ccm` のまま使える。
- 設定とローカル状態のディレクトリ名（`~/.config/ccm/`、`~/.local/state/ccm/`）も
  `ccm` のままにする。
- review-codecommit の利用者は自動では移行しない。review-codecommit の README で
  後継として案内する。
