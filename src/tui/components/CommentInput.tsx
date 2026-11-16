import { Box, Text } from "ink";
import React, { useState } from "react";
import { useKeys } from "../hooks/useKeys.js";
import { TextField } from "./TextField.js";

interface Props {
  onSubmit: (content: string) => void;
  onCancel: () => void;
  isPosting: boolean;
  error: string | null;
  onClearError: () => void;
  initialValue?: string;
  label?: string;
  postingMessage?: string;
  errorPrefix?: string;
  /** Tab: keep the text as a draft instead of posting it (spec: コメントの下書き). */
  onDraft?: ((content: string) => void) | undefined;
}

export const COMMENT_MAX_LENGTH = 10240;

export function CommentInput({
  onSubmit,
  onCancel,
  isPosting,
  error,
  onClearError,
  initialValue = "",
  label = "New Comment:",
  postingMessage = "Posting comment...",
  errorPrefix = "Failed to post comment:",
  onDraft,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [cut, setCut] = useState(false);

  useKeys((_input, key) => {
    if (error) {
      onClearError();
      return;
    }
    // The post is on its way: Tab would keep a draft of it too, and post it twice.
    if (isPosting) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab && onDraft) {
      const trimmed = value.trim();
      if (trimmed.length > 0) onDraft(trimmed);
    }
  });

  // A paste past the limit keeps what fits and says so; the user can still
  // edit what is left before posting it.
  function handleChange(newValue: string, wasCut: boolean) {
    setValue(newValue);
    setCut(wasCut);
  }

  function handleSubmit(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  }

  if (isPosting) {
    return (
      <Box flexDirection="column">
        <Text color="cyan">{postingMessage}</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">
          {errorPrefix} {error}
        </Text>
        <Text dimColor>Press any key to return</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <Box>
        <Text>&gt; </Text>
        <TextField
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          maxLength={COMMENT_MAX_LENGTH}
        />
      </Box>
      {cut && (
        <Text color="yellow">
          The text went past the limit and was cut to {COMMENT_MAX_LENGTH} characters.
        </Text>
      )}
      <Text dimColor>
        Enter submit{onDraft ? " Tab save as draft" : ""} Esc cancel ({value.trim().length}/
        {COMMENT_MAX_LENGTH})
      </Text>
    </Box>
  );
}
