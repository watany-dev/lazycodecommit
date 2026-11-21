import { useEffect, useRef } from "react";

export function useAsyncDismiss(
  isProcessing: boolean,
  error: string | null,
  onDismiss: () => void,
): void {
  const wasRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (isProcessing) {
      wasRef.current = true;
    } else if (wasRef.current && !error) {
      wasRef.current = false;
      onDismissRef.current();
    } else {
      wasRef.current = false;
    }
  }, [isProcessing, error]);
}
