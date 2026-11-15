# ADR 0004: PR テンプレートの置き場所

## Status

Accepted.

## Context

`ccm pr create` は、テンプレートファイルがあれば PR 本文の末尾に差し込む。
CodeCommit には PR テンプレートの仕組みも、決まった置き場所もない。
GitHub は `.github/pull_request_template.md` を使う。

## Decision

- 既定のパスは `.codecommit/pull_request_template.md`（リポジトリのルートから）。
- 設定ファイルの `pr.template` で変更できる。
- ファイルがなければ何も差し込まない。

## Consequences

- CodeCommit 用の置き場所が GitHub 用と分かれるので、両方にミラーしている
  リポジトリでも取り違えない。
- `.github/` などへのフォールバックは持たない。必要な人は `pr.template` で指定する。
