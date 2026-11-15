import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { type CommentDraft, canEdit } from "../../core/commentDrafts.js";
import { printable } from "../../core/text.js";
import { useKeys } from "../hooks/useKeys.js";
import { CommentInput } from "./CommentInput.js";
import { ConfirmPrompt } from "./ConfirmPrompt.js";

export interface DraftSubmitState {
  readonly isProcessing: boolean;
  /** Posted so far and the number to post, while posting. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** What happened on the last run, when it did not post everything. */
  readonly error: string | null;
  readonly clearError: () => void;
}

interface Props {
  drafts: readonly CommentDraft[];
  submit: DraftSubmitState;
  onSubmit: () => void;
  onEdit: (id: string, content: string) => void;
  onDiscard: (id: string) => void;
  onPostAnyway: (id: string) => void;
  onJump: (draft: CommentDraft) => void;
  onClose: () => void;
}

// The prompts here only ask; the work and its errors show in the list.
const IDLE = { isProcessing: false, processingMessage: "", error: null, onClearError: () => {} };

/** The pending comments of one PR (spec: コメントの下書き). */
export function DraftList({
  drafts,
  submit,
  onSubmit,
  onEdit,
  onDiscard,
  onPostAnyway,
  onJump,
  onClose,
}: Props) {
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"list" | "edit" | "discard" | "submit">("list");
  const [notice, setNotice] = useState<string | null>(null);
  const selected = drafts[cursor];
  const postable = drafts.filter((d) => d.problem?.kind !== "moved").length;

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, drafts.length - 1)));
  }, [drafts.length]);

  useKeys(
    (input, key) => {
      if (submit.error) {
        submit.clearError();
        return;
      }
      setNotice(null);
      if (input === "q" || input === "D" || key.escape) {
        onClose();
      } else if (input === "j" || key.downArrow) {
        setCursor((c) => Math.min(c + 1, drafts.length - 1));
      } else if (input === "k" || key.upArrow) {
        setCursor((c) => Math.max(c - 1, 0));
      } else if (key.return && selected?.target.kind === "inline") {
        onJump(selected);
      } else if (input === "e" && selected) {
        if (canEdit(selected)) setMode("edit");
        else setNotice("It may already be posted: press S to settle it before editing.");
      } else if (input === "d" && selected) {
        setMode("discard");
      } else if (input === "p" && selected?.problem?.kind === "moved") {
        onPostAnyway(selected.id);
      } else if (input === "S" && postable > 0) {
        setMode("submit");
      }
    },
    { isActive: mode === "list" && !submit.isProcessing },
  );

  if (submit.isProcessing) {
    const p = submit.progress;
    return (
      <Box flexDirection="column">
        <Text color="cyan">Posting drafts{p ? ` ${p.done + 1}/${p.total}` : ""}...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Drafts ({drafts.length}):</Text>
      {drafts.length === 0 && (
        <Text dimColor>No drafts. Press Tab in a comment box to keep one.</Text>
      )}
      {drafts.map((d, i) => (
        <Box key={d.id} flexDirection="column">
          <Text>
            {i === cursor ? "> " : "  "}
            <Text dimColor>{where(d)}</Text> {firstLine(d.content)}
          </Text>
          {d.problem && (
            <Text color={d.problem.kind === "failed" ? "red" : "yellow"}>
              {"    "}
              {problemLabel(d)}: {printable(d.problem.message)}
            </Text>
          )}
        </Box>
      ))}
      {notice && <Text color="yellow">{notice}</Text>}
      {submit.error && (
        <Box flexDirection="column">
          <Text color="red">{submit.error}</Text>
          <Text dimColor>Press any key to return</Text>
        </Box>
      )}
      {mode === "edit" && selected && (
        <CommentInput
          initialValue={selected.content}
          label="Edit draft:"
          onSubmit={(content) => {
            onEdit(selected.id, content);
            setMode("list");
          }}
          onCancel={() => setMode("list")}
          isPosting={false}
          error={null}
          onClearError={() => {}}
        />
      )}
      {mode === "discard" && selected && (
        <ConfirmPrompt
          message="Discard this draft?"
          onConfirm={() => {
            onDiscard(selected.id);
            setMode("list");
          }}
          onCancel={() => setMode("list")}
          {...IDLE}
        />
      )}
      {mode === "submit" && (
        <ConfirmPrompt
          message={`Post ${postable} draft${postable === 1 ? "" : "s"}, one comment at a time?`}
          onConfirm={() => {
            setMode("list");
            onSubmit();
          }}
          onCancel={() => setMode("list")}
          {...IDLE}
        />
      )}
      {mode === "list" && !submit.error && (
        <Text dimColor>
          j/k move Enter go to line e edit d discard{postable > 0 ? " S post all" : ""}
          {selected?.problem?.kind === "moved" ? " p post anyway" : ""} q close
        </Text>
      )}
    </Box>
  );
}

function where(d: CommentDraft): string {
  switch (d.target.kind) {
    case "general":
      return "[comment]";
    case "inline": {
      const l = d.target.location;
      return `${printable(l.filePath)}:${l.filePosition}${l.relativeFileVersion === "BEFORE" ? " (old)" : ""}`;
    }
    case "reply":
      return `↪ ${printable(d.target.replyTo.author)}`;
  }
}

function firstLine(text: string): string {
  const line = printable(text.split("\n")[0] ?? "");
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function problemLabel(d: CommentDraft): string {
  switch (d.problem?.kind) {
    case "failed":
      return "Not posted";
    case "unknown":
      return "May be posted (S retries safely)";
    default:
      return "Line moved";
  }
}
