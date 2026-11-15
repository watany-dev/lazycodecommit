import { Text } from "ink";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewService } from "../core/review.js";
import { useKeys } from "./hooks/useKeys.js";

const exit = vi.fn();
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit }),
}));

// The PR list has its own tests; here it only has to show which repository it
// was opened for and hand control back on q.
vi.mock("./ReviewApp.js", () => ({
  App: ({ repository, onExit }: { repository: string; onExit: () => void }) => {
    useKeys((input) => {
      if (input === "q") onExit();
    });
    return <Text>PR list of {repository}</Text>;
  },
}));

const { PickScreen } = await import("./PickScreen.js");

function setup(current: string | undefined) {
  const actions = {
    listRepositories: vi.fn(async () => ["demo", "infra"]),
    watched: () => [] as readonly string[],
    toggleWatch: vi.fn(async () => [] as readonly string[]),
  };
  const onDone = vi.fn();
  const reviewService = vi.fn((): ReviewService => ({}) as ReviewService);
  const r = render(
    <PickScreen
      actions={actions}
      current={current}
      reviewService={reviewService}
      onDone={onDone}
    />,
  );
  return { ...r, onDone, reviewService };
}

beforeEach(() => {
  exit.mockReset();
});

describe("PickScreen", () => {
  it("hands back the repository picked with Enter and closes", async () => {
    const { stdin, lastFrame, onDone } = setup("demo");
    await vi.waitFor(() => expect(lastFrame()).toContain("infra"));
    stdin.write("j");
    await vi.waitFor(() => expect(lastFrame()).toMatch(/> +infra/));
    stdin.write("\r");
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("infra"));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("hands back nothing on q and closes, also when no repository is current", async () => {
    const { stdin, lastFrame, onDone } = setup(undefined);
    await vi.waitFor(() => expect(lastFrame()).toContain("infra"));
    stdin.write("q");
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith());
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("opens a repository's PR list on p and comes back to the picker", async () => {
    const { stdin, lastFrame, onDone, reviewService } = setup("demo");
    await vi.waitFor(() => expect(lastFrame()).toContain("infra"));
    stdin.write("p");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR list of demo"));
    expect(reviewService).toHaveBeenCalledWith("demo");
    stdin.write("q");
    await vi.waitFor(() => expect(lastFrame()).toContain("infra"));
    expect(lastFrame()).not.toContain("PR list of");
    expect(onDone).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
