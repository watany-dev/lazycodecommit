export interface DisplayLine {
  type:
    | "header"
    | "separator"
    | "add"
    | "delete"
    | "context"
    | "truncation"
    | "truncate-context"
    | "comment-header"
    | "comment"
    | "inline-comment"
    | "inline-reply"
    | "comment-reply"
    | "fold-indicator";
  text: string;
  filePath?: string;
  diffKey?: string;
  beforeLineNumber?: number;
  afterLineNumber?: number;
  threadIndex?: number | undefined;
  commentId?: string | undefined;
  reactionText?: string;
}
