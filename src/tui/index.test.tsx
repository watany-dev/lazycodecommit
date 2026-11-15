import { describe, expect, it, vi } from "vitest";
import { fakeGit } from "../testing/fakes.js";

const render = vi.fn((_node: unknown) => ({ waitUntilExit: async () => {} }));
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  render: (node: unknown) => render(node),
}));

const { openReview } = await import("./index.js");

describe("openReview", () => {
  it("renders the review app and waits for it to exit", async () => {
    await openReview({ repository: "demo", start: { pullRequestId: "4" }, region: "us-west-2" });
    await openReview({ repository: "demo", start: null, profile: "dev", git: fakeGit() });
    const props = render.mock.calls.map(([node]) => (node as { props: object }).props);
    expect(props[0]).toMatchObject({ repository: "demo", start: { pullRequestId: "4" } });
    expect(props[1]).toMatchObject({ start: null });
  });
});
