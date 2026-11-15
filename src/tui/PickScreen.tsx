import { useApp } from "ink";
import { useState } from "react";
import type { HomeActions } from "../core/home.js";
import type { ReviewService } from "../core/review.js";
import { RepoPicker } from "./components/RepoPicker.js";
import { App as ReviewApp } from "./ReviewApp.js";

interface Props {
  actions: Pick<HomeActions, "listRepositories" | "watched" | "toggleWatch">;
  current: string | undefined;
  reviewService: (repository: string) => ReviewService;
  /** Enter: the repository the branch table or browse switches to; q: none. */
  onDone: (repository?: string) => void;
}

/** spec: リポジトリ選択, opened with r from the branch table or browse. */
export function PickScreen({ actions, current, reviewService, onDone }: Props) {
  const { exit } = useApp();
  const [listing, setListing] = useState<string | null>(null);
  if (listing !== null) {
    return (
      <ReviewApp
        service={reviewService(listing)}
        repository={listing}
        start={null}
        onExit={() => setListing(null)}
      />
    );
  }
  return (
    <RepoPicker
      actions={actions}
      current={current === undefined ? undefined : [current]}
      onSelect={(repository) => {
        onDone(repository);
        exit();
      }}
      onOpenList={setListing}
      onBack={() => {
        onDone();
        exit();
      }}
    />
  );
}
