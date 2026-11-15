---
name: wrapup
description: >
  Post-work review gate. Run after a task's implementation is done and before
  handing it off: correctness review, over-engineering review, take in only the
  findings worth taking, then sweep comments. Fire when the user invokes
  /wrapup or says "作業後レビュー", "wrapup", "仕上げて", or when an
  implementation task is finished and about to be committed or pushed.
---

# wrapup

実装が終わった後の仕上げ。レビュー2本を回し、**有用な指摘だけ**を取り込み、
最後にコメントを掃除する。

## 手順

1. **CI**: `bun run ci`（CI と同じ全チェック）が通っていること。落ちていたら
   ここで直す
2. **正しさのレビュー**: Claude Code なら `/code-review`。それ以外のエージェント
   （Codex / Cursor）は同等のレビューを自分で行う —
   `git diff <base>...HEAD` を読み、バグ・エラー処理漏れ・境界条件・
   テスト欠落を指摘として列挙する
3. **過剰設計のレビュー**: `ponytail-review` スキルを差分に適用する
4. **取り込み**: 下の基準で選別し、採用したものだけ直す
5. **コメント掃除**: `cleanup-comments` スキルを適用する
6. **CI を通してコミット**。1〜5 で入った修正は実装と同じコミットでよいが、
   コメントのみの変更は別コミットにする

## 取り込み基準

採用する:

- 動作が変わる欠陥（誤動作・クラッシュ・リーク・境界条件）
- 差分が短くなる指摘（`delete:` / `stdlib:` / `yagni:` / `shrink:`）
- テストが無い分岐の追加
- 外から来る入力（AWS API の応答、設定ファイル、git の状態）の想定外の値や
  エラーを黙って捨てている。捨ててよいのは、user に影響しないとコメントで
  言えるときだけ
- 認証情報やトークンをログ・画面・エラーメッセージに出している
- 仕様の設計原則・層の約束に反している（git を再実装している、`git/` 層以外
  から git を呼んでいる、依存の向きが `cli/`・`tui/` → `core/` →
  `aws/`・`git/`・`state/` の一方向になっていない、CLI サブコマンドの経路で
  Ink / React を読み込んでいる、依存を増やしている）

見送る:

- 好みの問題、命名の言い換え、差分の外
- 今の要件に無い一般化・将来への備え
- 既存コードの様式に反する提案（周囲に合わせる）

見送った指摘は理由を 1 行で報告する。黙って捨てない。

## 注意

- ドキュメント同期は wrapup の手順に含めない。README や `docs/`、`CLAUDE.md`
  を更新する必要があるときは `update-docs` を個別に呼ぶ。
- レビューや検証のために、user が許可していない AWS リソースへ書き込むことは
  しない。
