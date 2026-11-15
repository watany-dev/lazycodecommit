import type { CodeCommitApi, FolderEntry } from "../aws/codecommit.js";
import type { RepoContext } from "./context.js";
import { UsageError, UserError } from "./errors.js";
import { repositoryConsoleUrl } from "./pr.js";

export type BrowseNode =
  | {
      readonly kind: "folder";
      readonly ref: string;
      readonly path: string;
      readonly entries: readonly FolderEntry[];
    }
  | {
      readonly kind: "file";
      readonly ref: string;
      readonly path: string;
      readonly size?: number;
      /** Set unless the file is binary or too large to fetch. */
      readonly text?: string;
      readonly binary?: true;
      /** Over GetFile's size limit: only a clone can show it. */
      readonly tooLarge?: true;
    };

export interface BrowseDeps {
  readonly api: CodeCommitApi;
  readonly ctx: Pick<RepoContext, "repository">;
}

/** No such path at the ref; the ref itself exists. */
export class NotFoundError extends UserError {}

export const ENTRY_MARK: Record<FolderEntry["type"], string> = {
  folder: "/",
  file: "",
  symlink: "@",
  submodule: " (submodule)",
};

const BAD_REF = new Set(["CommitDoesNotExistException", "InvalidCommitException"]);
/** git's own test: a NUL in the first 8000 bytes means binary. */
const BINARY_SNIFF = 8000;

/** "/src//lib/" → "src/lib"; "" is the root. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) throw new UsageError(`Not a path in the repository: ${path}`);
    } else parts.push(part);
  }
  return parts.join("/");
}

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF).includes(0);
}

const ORDER: Record<FolderEntry["type"], number> = { folder: 0, file: 1, symlink: 1, submodule: 1 };

/**
 * The folder or file at `path`. A path ending in "/" is only tried as a folder;
 * otherwise a missing folder falls back to a file of that name.
 */
export async function openPath(ref: string, path: string, deps: BrowseDeps): Promise<BrowseNode> {
  const { api, ctx } = deps;
  const clean = normalizePath(path);
  const folderOnly = clean === "" || path.endsWith("/");
  try {
    const entries = await api.getFolder(ctx.repository, ref, clean);
    if (entries) {
      const sorted = entries.toSorted(
        (a, b) => ORDER[a.type] - ORDER[b.type] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      return { kind: "folder", ref, path: clean, entries: sorted };
    }
    if (folderOnly) throw new NotFoundError(`${ctx.repository} has no folder ${clean} at ${ref}.`);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await api.getFile(ctx.repository, ref, clean);
    } catch (error) {
      if ((error as Error).name === "FileTooLargeException")
        return { kind: "file", ref, path: clean, tooLarge: true };
      throw error;
    }
    if (!bytes)
      throw new NotFoundError(`${ctx.repository} has no file or folder ${clean} at ${ref}.`);
    return isBinary(bytes)
      ? { kind: "file", ref, path: clean, size: bytes.byteLength, binary: true }
      : {
          kind: "file",
          ref,
          path: clean,
          size: bytes.byteLength,
          // Keeps a BOM, so the text is the file's; invalid UTF-8 shows as U+FFFD.
          text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
        };
  } catch (error) {
    if (BAD_REF.has((error as Error).name))
      throw new UserError(`${ctx.repository} has no branch or commit named ${ref}.`);
    throw error;
  }
}

/** A full or abbreviated commit ID; anything else is taken as a branch. */
const COMMIT_ID = /^[0-9a-f]{7,40}$/i;
const encode = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export function browseConsoleUrl(
  region: string,
  repository: string,
  ref: string,
  path: string,
): string {
  const at = COMMIT_ID.test(ref) ? ref : `refs/heads/${encode(ref)}`;
  return repositoryConsoleUrl(region, repository, `browse/${at}/--/${encode(path)}`);
}

/** What the browse screen does, bound to one repository. */
export interface BrowseActions {
  readonly repository: string;
  /** The ref to open first: the one asked for, or the default branch. */
  readonly startRef: string;
  open(ref: string, path: string): Promise<BrowseNode>;
  branches(): Promise<string[]>;
  consoleUrl(ref: string, path: string): string;
}

export async function browseActions(
  deps: BrowseDeps,
  region: string,
  ref?: string,
): Promise<BrowseActions> {
  const { api, ctx } = deps;
  const startRef = ref ?? (await api.defaultBranch(ctx.repository));
  if (!startRef)
    throw new UserError(`${ctx.repository} has no default branch yet (is it empty?). Pass --ref.`);
  return {
    repository: ctx.repository,
    startRef,
    open: (at, path) => openPath(at, path, deps),
    branches: async () => (await api.listBranches(ctx.repository)).toSorted(),
    consoleUrl: (at, path) => browseConsoleUrl(region, ctx.repository, at, path),
  };
}
