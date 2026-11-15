import { Box, Text } from "ink";
import React from "react";
import type { ConflictSummary, MergeStrategy } from "../../core/review.js";
import { useKeys } from "../hooks/useKeys.js";

export function ConflictDisplay({
  conflictSummary,
  strategy,
  onDismiss,
}: {
  conflictSummary: ConflictSummary;
  strategy: MergeStrategy;
  onDismiss: () => void;
}) {
  useKeys(() => {
    onDismiss();
  });

  const { conflictCount, conflictFiles } = conflictSummary;
  return (
    <Box flexDirection="column">
      {conflictCount > 0 ? (
        <>
          <Text color="red">
            ✗ Cannot merge: {conflictCount} conflicting file{conflictCount !== 1 ? "s" : ""}
          </Text>
          <Text> </Text>
          {conflictFiles.map((file) => (
            <Text key={file}> {file}</Text>
          ))}
          <Text> </Text>
          <Text>Resolve conflicts before merging.</Text>
        </>
      ) : strategy === "fast-forward" ? (
        // CodeCommit answers mergeable: false with no conflicts when the
        // destination has commits the source does not.
        <>
          <Text color="red">✗ Cannot fast-forward: the destination branch has moved on.</Text>
          <Text>Choose squash or three-way merge instead.</Text>
        </>
      ) : (
        <Text color="red">✗ CodeCommit says the branches cannot be merged with {strategy}.</Text>
      )}
      <Text dimColor>Press any key to return</Text>
    </Box>
  );
}
