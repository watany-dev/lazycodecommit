# ADR 0001: コマンド名とパッケージ名

## Status

Accepted.

## Context

仕様書はコマンド名を仮に `ccm` とした。`cc` は C コンパイラと衝突するため避けている。
配布は npm パッケージで、CloudShell では `npx` で起動する（ADR 0002）。
watany はコマンド名を `lazycc` に決めた（2026-11-15）。

2026-11-15 時点の npm レジストリ:

| 名前 | 状態 |
|---|---|
| `lazycodecommit` | 空き |
| `lazycc` | 別のパッケージが使用中（Codex と Cursor 向けのツール、2026 年更新）。bin にも `lazycc` を持つ |
| `ccm` | 別のパッケージが使用中（2.2.0、2022 年更新） |
| `review-codecommit` | watany が公開済み（0.1.3） |

`npx <名前>` は、その名前のパッケージを取得して実行する。`npm exec` は、パッケージの
bin が 1 つならそれを、複数ならパッケージ名と同じ名前の bin を実行する。

## Decision

- コマンド名は `lazycc`。
- npm パッケージ名は `lazycodecommit`。`lazycc` は npm で使われているため。
  リポジトリ名とも一致する。
- bin は `lazycc` と `lazycodecommit` の 2 つを持つ。
  - `npx lazycodecommit` はパッケージ名と同じ bin を実行するので、CloudShell で
    インストールなしに起動できる。
  - グローバルにインストールした後は `lazycc` で呼ぶ。
- ドキュメントでは `npx lazycc` を案内しない。npm の `lazycc` は別のパッケージのため。
- 設定とローカル状態のディレクトリ名は `lazycc` にする（`~/.config/lazycc/`、
  `~/.local/state/lazycc/`）。

## Consequences

- npm の `lazycc` パッケージを同時にグローバルインストールすると、`lazycc` コマンドが
  衝突する。利用者が重なる見込みは低いので受け入れる。
- review-codecommit の利用者は自動では移行しない。review-codecommit の README で
  後継として案内する。
