import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { useAsyncDismiss } from "./useAsyncDismiss.js";

function TestComponent({
  isProcessing,
  error,
  onDismiss,
}: {
  isProcessing: boolean;
  error: string | null;
  onDismiss: () => void;
}) {
  useAsyncDismiss(isProcessing, error, onDismiss);
  return <Text>{`processing: ${isProcessing}`}</Text>;
}

describe("useAsyncDismiss", () => {
  it("does not call onDismiss initially", () => {
    const onDismiss = vi.fn();
    render(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("calls onDismiss when isProcessing transitions from true to false with no error", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />,
    );
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not call onDismiss when isProcessing transitions from true to false with an error", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />,
    );
    rerender(<TestComponent isProcessing={false} error="Something failed" onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not call onDismiss when isProcessing starts as false", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />,
    );
    rerender(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("resets tracking after success so subsequent operations work correctly", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />,
    );
    rerender(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(<TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />);
    rerender(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("resets tracking after error so subsequent success calls onDismiss", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />,
    );
    rerender(<TestComponent isProcessing={false} error="Failed" onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />);
    rerender(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("useAsyncDismiss after a failure", () => {
  it("does not dismiss when the error of a failed operation is cleared", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />,
    );
    rerender(<TestComponent isProcessing={false} error="failed" onDismiss={onDismiss} />);
    rerender(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses once, even when the error changes between empty values afterwards", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TestComponent isProcessing={true} error={null} onDismiss={onDismiss} />,
    );
    rerender(<TestComponent isProcessing={false} error={null} onDismiss={onDismiss} />);
    rerender(<TestComponent isProcessing={false} error="" onDismiss={onDismiss} />);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
