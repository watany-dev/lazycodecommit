import { Box, Text } from "ink";
import React from "react";
import type { ConflictSummary } from "../../core/review.js";
import { useKeys } from "../hooks/useKeys.js";

export function ConflictDisplay({
  conflictSummary,
  onDismiss,
}: {
  conflictSummary: ConflictSummary;
  onDismiss: () => void;
}) {
  useKeys(() => {
    onDismiss();
  });

  return (
    <Box flexDirection="column">
      <Text color="red">
        ✗ Cannot merge: {conflictSummary.conflictCount} conflicting file
        {conflictSummary.conflictCount !== 1 ? "s" : ""}
      </Text>
      <Text> </Text>
      {conflictSummary.conflictFiles.map((file) => (
        <Text key={file}> {file}</Text>
      ))}
      <Text> </Text>
      <Text>Resolve conflicts before merging.</Text>
      <Text dimColor>Press any key to return</Text>
    </Box>
  );
}
