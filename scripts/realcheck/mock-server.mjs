// A small stand-in for CodeCommit (JSON 1.1) and STS, backed by bare git
// repositories, so realcheck.mjs can be run end to end without AWS. It answers
// the way lazycc assumes CodeCommit answers; the real run shows where it differs.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const ACCOUNT = "123456789012";

/** Access key id → caller. A limited caller is refused every CodeCommit call. */
export const USERS = {
  AKIDMAIN: { arn: `arn:aws:iam::${ACCOUNT}:user/alice` },
  AKIDOTHER: { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Reviewer/bob` },
  AKIDLIMITED: { arn: `arn:aws:iam::${ACCOUNT}:user/carol`, limited: true },
};

const STS_IDENTITY = new Map(
  Object.values(USERS).map((u) => [
    u,
    `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${u.arn}</Arn><UserId>AIDMOCK</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>mock</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
  ]),
);
const STS_DENIED =
  '<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error><RequestId>mock</RequestId></ErrorResponse>';

class ApiError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

const now = () => Date.now() / 1000;
const b64 = (buf) => Buffer.from(buf).toString("base64");
const strip = (ref) => ref.replace("refs/heads/", "");
/** A PR as CodeCommit returns it, without the mock's bookkeeping. */
const view = (pr) => {
  const { events: _events, approvals: _approvals, ...rest } = pr;
  return rest;
};

function touch(pr, type, actor) {
  pr.lastActivityDate = now();
  pr.events.push({
    pullRequestId: pr.pullRequestId,
    eventDate: pr.lastActivityDate,
    pullRequestEventType: type,
    actorArn: actor,
  });
}

function person(line) {
  const m = /^(.*) <(.*)> (\d+ [+-]\d{4})$/.exec(line ?? "") ?? [];
  return { name: m[1], email: m[2], date: m[3] };
}

function finishMerge(pr, caller) {
  const t = pr.pullRequestTargets[0];
  t.mergeMetadata = { isMerged: true, mergedBy: caller };
  pr.pullRequestStatus = "CLOSED";
  touch(pr, "PULL_REQUEST_MERGE_STATE_CHANGED", caller);
  return { pullRequest: view(pr) };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
  res.end(JSON.stringify(payload));
}

export function startMockServer(gitRoot) {
  mkdirSync(gitRoot, { recursive: true });
  const repos = new Map();
  const prs = new Map();
  const comments = [];
  const postComment = (input, c) => {
    const pr = prOf(input.pullRequestId);
    const comment = newComment(input.content, c.caller.arn);
    comments.push({ ...input, comment });
    touch(pr, "PULL_REQUEST_COMMENT", c.caller.arn);
    return {
      repositoryName: input.repositoryName,
      pullRequestId: input.pullRequestId,
      beforeCommitId: input.beforeCommitId,
      afterCommitId: input.afterCommitId,
      ...(input.location ? { location: input.location } : {}),
      comment,
    };
  };
  const postReply = ({ inReplyTo, content }, c) => {
    const parent = comments.find((x) => x.comment.commentId === inReplyTo);
    if (!parent) throw new ApiError("CommentDoesNotExistException", "no such comment");
    const comment = { ...newComment(content, c.caller.arn), inReplyTo };
    comments.push({ ...parent, comment });
    touch(prOf(parent.pullRequestId), "PULL_REQUEST_COMMENT", c.caller.arn);
    return { comment };
  };
  // clientRequestToken → the first request's parameters and answer, as CodeCommit keeps them.
  const tokens = new Map();
  const idempotent = (input, post) => {
    const { clientRequestToken: token, ...params } = input;
    if (!token) return post();
    const key = JSON.stringify(params);
    const seen = tokens.get(token);
    if (seen && seen.key !== key)
      throw new ApiError(
        "IdempotencyParameterMismatchException",
        "token reused with other parameters",
      );
    if (seen) return seen.answer;
    const answer = post();
    tokens.set(token, { key, answer });
    return answer;
  };
  let nextPr = 1;

  const git = (repo, args, input) =>
    execFileSync("git", ["-C", join(gitRoot, repo), ...args], {
      encoding: input === undefined ? "utf8" : undefined,
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  const tryGit = (repo, args) => {
    try {
      return git(repo, args).trim();
    } catch {
      return undefined;
    }
  };
  const tip = (repo, branch) =>
    tryGit(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const commitOf = (repo, spec) => {
    const id = tryGit(repo, ["rev-parse", "--verify", `${spec}^{commit}`]);
    if (!id) throw new ApiError("CommitDoesNotExistException", `Could not find commit ${spec}`);
    return id;
  };
  const branches = (repo) =>
    (tryGit(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "")
      .split("\n")
      .filter(Boolean);

  const repoOf = (name, region) => {
    const r = repos.get(name);
    if (!r) throw new ApiError("RepositoryDoesNotExistException", `${name} does not exist`);
    if (!r.defaultBranch) {
      const all = branches(name);
      r.defaultBranch = all.includes("main") ? "main" : all[0];
    }
    return {
      repositoryName: name,
      repositoryId: r.id,
      accountId: ACCOUNT,
      Arn: `arn:aws:codecommit:${region}:${ACCOUNT}:${name}`,
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
      cloneUrlHttp: `https://git-codecommit.${region}.amazonaws.com/v1/repos/${name}`,
      cloneUrlSsh: `ssh://git-codecommit.${region}.amazonaws.com/v1/repos/${name}`,
      creationDate: r.created,
      lastModifiedDate: r.created,
    };
  };

  /** CodeCommit moves an open PR's source commit when its branch is pushed. */
  const prOf = (id) => {
    const pr = prs.get(String(id));
    if (!pr)
      throw new ApiError("PullRequestDoesNotExistException", `Pull request ${id} does not exist`);
    const t = pr.pullRequestTargets[0];
    if (pr.pullRequestStatus === "OPEN") {
      const branch = t.sourceReference.replace("refs/heads/", "");
      const current = tip(t.repositoryName, branch);
      if (current && current !== t.sourceCommit) {
        t.sourceCommit = current;
        pr.revisionId = randomUUID();
        touch(pr, "PULL_REQUEST_SOURCE_REFERENCE_UPDATED", pr.authorArn);
      }
      const dest = tip(t.repositoryName, t.destinationReference.replace("refs/heads/", ""));
      if (dest) t.destinationCommit = dest;
    }
    return pr;
  };

  const mergeCheck = (input) => {
    const pr = prOf(input.pullRequestId);
    const t = pr.pullRequestTargets[0];
    if (pr.pullRequestStatus !== "OPEN")
      throw new ApiError("PullRequestAlreadyClosedException", "closed");
    if (input.sourceCommitId && input.sourceCommitId !== t.sourceCommit)
      throw new ApiError(
        "TipOfSourceReferenceIsDifferentException",
        "The tip of the source branch has changed.",
      );
    return { pr, t, dest: t.destinationReference };
  };

  const ops = {
    CreateRepository({ repositoryName }, c) {
      if (repos.has(repositoryName)) throw new ApiError("RepositoryNameExistsException", "exists");
      execFileSync("git", ["init", "-q", "--bare", join(gitRoot, repositoryName)]);
      repos.set(repositoryName, { id: randomUUID(), created: now() });
      return { repositoryMetadata: repoOf(repositoryName, c.region) };
    },
    DeleteRepository({ repositoryName }) {
      const r = repos.get(repositoryName);
      repos.delete(repositoryName);
      rmSync(join(gitRoot, repositoryName), { recursive: true, force: true });
      return r ? { repositoryId: r.id } : {};
    },
    GetRepository: ({ repositoryName }, c) => ({
      repositoryMetadata: repoOf(repositoryName, c.region),
    }),
    ListRepositories: () => ({
      repositories: [...repos].map(([name, r]) => ({ repositoryName: name, repositoryId: r.id })),
    }),
    ListBranches: ({ repositoryName }, c) => (
      repoOf(repositoryName, c.region), { branches: branches(repositoryName) }
    ),
    GetBranch({ repositoryName, branchName }, c) {
      repoOf(repositoryName, c.region);
      const commitId = tip(repositoryName, branchName);
      if (!commitId)
        throw new ApiError("BranchDoesNotExistException", `${branchName} does not exist`);
      return { branch: { branchName, commitId } };
    },
    DeleteBranch({ repositoryName, branchName }) {
      const commitId = tip(repositoryName, branchName);
      if (!commitId)
        throw new ApiError("BranchDoesNotExistException", `${branchName} does not exist`);
      git(repositoryName, ["update-ref", "-d", `refs/heads/${branchName}`]);
      return { deletedBranch: { branchName, commitId } };
    },
    CreatePullRequest({ title, description, targets }, c) {
      const [{ repositoryName, sourceReference, destinationReference }] = targets;
      repoOf(repositoryName, c.region);
      const source = tip(repositoryName, strip(sourceReference));
      const dest = tip(
        repositoryName,
        strip(destinationReference ?? repos.get(repositoryName).defaultBranch),
      );
      if (!source)
        throw new ApiError("ReferenceDoesNotExistException", `${sourceReference} does not exist`);
      const id = String(nextPr++);
      const pr = {
        pullRequestId: id,
        title,
        ...(description ? { description } : {}),
        pullRequestStatus: "OPEN",
        authorArn: c.caller.arn,
        creationDate: now(),
        lastActivityDate: now(),
        revisionId: randomUUID(),
        clientRequestToken: randomUUID(),
        approvalRules: [],
        pullRequestTargets: [
          {
            repositoryName,
            sourceReference: `refs/heads/${strip(sourceReference)}`,
            destinationReference: `refs/heads/${strip(destinationReference)}`,
            sourceCommit: source,
            destinationCommit: dest,
            mergeBase: tryGit(repositoryName, ["merge-base", source, dest]),
            mergeMetadata: { isMerged: false },
          },
        ],
        events: [],
        approvals: new Set(),
      };
      prs.set(id, pr);
      touch(pr, "PULL_REQUEST_CREATED", c.caller.arn);
      return { pullRequest: view(pr) };
    },
    GetPullRequest: ({ pullRequestId }) => ({ pullRequest: view(prOf(pullRequestId)) }),
    ListPullRequests({ repositoryName, pullRequestStatus }, c) {
      repoOf(repositoryName, c.region);
      const ids = [...prs.values()]
        .filter((p) => p.pullRequestTargets[0].repositoryName === repositoryName)
        .filter((p) => !pullRequestStatus || p.pullRequestStatus === pullRequestStatus)
        .map((p) => p.pullRequestId)
        .toReversed();
      return { pullRequestIds: ids };
    },
    GetPullRequestApprovalStates: ({ pullRequestId }) => ({
      approvals: [...prOf(pullRequestId).approvals].map((userArn) => ({
        userArn,
        approvalState: "APPROVE",
      })),
    }),
    EvaluatePullRequestApprovalRules: ({ pullRequestId, revisionId }) => (
      prOf(pullRequestId),
      {
        evaluation: {
          approved: true,
          overridden: false,
          approvalRulesSatisfied: [],
          approvalRulesNotSatisfied: [],
        },
        revisionId,
      }
    ),
    GetMergeConflicts({ destinationCommitSpecifier, sourceCommitSpecifier }) {
      return {
        mergeable: true,
        destinationCommitId: destinationCommitSpecifier,
        sourceCommitId: sourceCommitSpecifier,
        conflictMetadataList: [],
      };
    },
    PostCommentForPullRequest: (input, c) => idempotent(input, () => postComment(input, c)),
    PostCommentReply: (input, c) => idempotent(input, () => postReply(input, c)),
    PutCommentReaction({ commentId }, c) {
      const parent = comments.find((x) => x.comment.commentId === commentId);
      if (!parent) throw new ApiError("CommentDoesNotExistException", "no such comment");
      touch(prOf(parent.pullRequestId), "PULL_REQUEST_COMMENT_REACTION", c.caller.arn);
      return {};
    },
    GetCommentReactions: () => ({ reactionsForComment: [] }),
    GetCommentsForPullRequest({ pullRequestId }) {
      const groups = new Map();
      for (const x of comments.filter((y) => y.pullRequestId === String(pullRequestId))) {
        const key = JSON.stringify([x.beforeCommitId, x.afterCommitId, x.location ?? null]);
        if (!groups.has(key))
          groups.set(key, {
            pullRequestId: x.pullRequestId,
            repositoryName: x.repositoryName,
            beforeCommitId: x.beforeCommitId,
            afterCommitId: x.afterCommitId,
            ...(x.location ? { location: x.location } : {}),
            comments: [],
          });
        groups.get(key).comments.push(x.comment);
      }
      return { commentsForPullRequestData: [...groups.values()] };
    },
    DescribePullRequestEvents: ({ pullRequestId }) => ({
      pullRequestEvents: prOf(pullRequestId).events,
    }),
    UpdatePullRequestTitle({ pullRequestId, title }, c) {
      const pr = prOf(pullRequestId);
      pr.title = title;
      touch(pr, "PULL_REQUEST_TITLE_UPDATED", c.caller.arn);
      return { pullRequest: view(pr) };
    },
    UpdatePullRequestDescription({ pullRequestId, description }, c) {
      const pr = prOf(pullRequestId);
      pr.description = description;
      touch(pr, "PULL_REQUEST_DESCRIPTION_UPDATED", c.caller.arn);
      return { pullRequest: view(pr) };
    },
    UpdatePullRequestApprovalState({ pullRequestId, approvalState }, c) {
      const pr = prOf(pullRequestId);
      if (pr.authorArn === c.caller.arn)
        throw new ApiError(
          "PullRequestCannotBeApprovedByAuthorException",
          "The author cannot approve.",
        );
      if (approvalState === "APPROVE") pr.approvals.add(c.caller.arn);
      else pr.approvals.delete(c.caller.arn);
      touch(pr, "PULL_REQUEST_APPROVAL_STATE_CHANGED", c.caller.arn);
      return {};
    },
    UpdatePullRequestStatus({ pullRequestId, pullRequestStatus }, c) {
      const pr = prOf(pullRequestId);
      pr.pullRequestStatus = pullRequestStatus;
      touch(pr, "PULL_REQUEST_STATUS_CHANGED", c.caller.arn);
      return { pullRequest: view(pr) };
    },
    MergePullRequestByFastForward(input, c) {
      const { pr, t, dest } = mergeCheck(input);
      const repo = t.repositoryName;
      const destTip = tip(repo, dest.replace("refs/heads/", ""));
      if (tryGit(repo, ["merge-base", "--is-ancestor", destTip, t.sourceCommit]) === undefined)
        throw new ApiError("ManualMergeRequiredException", "Cannot fast-forward.");
      git(repo, ["update-ref", dest, t.sourceCommit]);
      return finishMerge(pr, c.caller.arn);
    },
    MergePullRequestBySquash(input, c) {
      const { pr, t, dest } = mergeCheck(input);
      const repo = t.repositoryName;
      const destTip = tip(repo, dest.replace("refs/heads/", ""));
      const tree = git(repo, ["merge-tree", "--write-tree", destTip, t.sourceCommit])
        .trim()
        .split("\n")[0];
      const commit = git(repo, ["commit-tree", tree, "-p", destTip, "-m", pr.title]).trim();
      git(repo, ["update-ref", dest, commit]);
      return finishMerge(pr, c.caller.arn);
    },
    GetFolder({ repositoryName, commitSpecifier, folderPath }) {
      const commitId = commitOf(repositoryName, commitSpecifier);
      const path = (folderPath ?? "/").replace(/^\/+|\/+$/g, "");
      const spec = `${commitId}:${path}`;
      if (tryGit(repositoryName, ["cat-file", "-t", spec]) !== "tree")
        throw new ApiError("FolderDoesNotExistException", `${folderPath} is not a folder`);
      const out = {
        commitId,
        folderPath: path ? `/${path}` : "/",
        treeId: tryGit(repositoryName, ["rev-parse", spec]),
      };
      Object.assign(out, { subFolders: [], files: [], symbolicLinks: [], subModules: [] });
      for (const line of git(repositoryName, ["ls-tree", spec]).split("\n").filter(Boolean)) {
        const [meta, name] = line.split("\t");
        const [mode, type, id] = meta.split(" ");
        const entry = { absolutePath: path ? `${path}/${name}` : name, relativePath: name };
        if (type === "tree") out.subFolders.push({ ...entry, treeId: id });
        else if (type === "commit") out.subModules.push({ ...entry, commitId: id });
        else if (mode === "120000")
          out.symbolicLinks.push({ ...entry, blobId: id, fileMode: "SYMLINK" });
        else
          out.files.push({
            ...entry,
            blobId: id,
            fileMode: mode === "100755" ? "EXECUTABLE" : "NORMAL",
          });
      }
      return out;
    },
    GetFile({ repositoryName, commitSpecifier, filePath }) {
      const commitId = commitOf(repositoryName, commitSpecifier);
      const spec = `${commitId}:${filePath.replace(/^\/+/, "")}`;
      if (tryGit(repositoryName, ["cat-file", "-t", spec]) !== "blob")
        throw new ApiError("FileDoesNotExistException", `${filePath} does not exist`);
      const content = git(repositoryName, ["cat-file", "blob", spec], "");
      return {
        commitId,
        blobId: tryGit(repositoryName, ["rev-parse", spec]),
        filePath,
        fileMode: "NORMAL",
        fileSize: content.length,
        fileContent: b64(content),
      };
    },
    GetBlob({ repositoryName, blobId }) {
      return { content: b64(git(repositoryName, ["cat-file", "blob", blobId], "")) };
    },
    GetCommit({ repositoryName, commitId }) {
      const id = commitOf(repositoryName, commitId);
      const raw = git(repositoryName, ["cat-file", "commit", id]);
      const [head, ...msg] = raw.split("\n\n");
      const field = (k) =>
        head
          .split("\n")
          .filter((l) => l.startsWith(`${k} `))
          .map((l) => l.slice(k.length + 1));
      return {
        commit: {
          commitId: id,
          treeId: field("tree")[0],
          parents: field("parent"),
          message: msg.join("\n\n"),
          author: person(field("author")[0]),
          committer: person(field("committer")[0]),
        },
      };
    },
    GetDifferences({ repositoryName, beforeCommitSpecifier, afterCommitSpecifier }) {
      const after = commitOf(repositoryName, afterCommitSpecifier);
      const before = beforeCommitSpecifier
        ? commitOf(repositoryName, beforeCommitSpecifier)
        : undefined;
      const args = before
        ? ["diff-tree", "-r", "--no-renames", before, after]
        : ["ls-tree", "-r", after];
      const differences = git(repositoryName, args)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split("\t");
          if (!before)
            return {
              afterBlob: { blobId: meta.split(" ")[2], path, mode: "100644" },
              changeType: "A",
            };
          const [, , beforeId, afterId, change] = meta.split(" ");
          const blob = (id) => ({ blobId: id, path, mode: "100644" });
          return {
            ...(change !== "A" ? { beforeBlob: blob(beforeId) } : {}),
            ...(change !== "D" ? { afterBlob: blob(afterId) } : {}),
            changeType: change,
          };
        });
      return { differences };
    },
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      const [, key, region] = /Credential=([^/]+)\/\d+\/([^/]+)\//.exec(auth) ?? [];
      const caller = USERS[key];
      const target = String(req.headers["x-amz-target"] ?? "");
      if (!target) {
        // STS (query protocol): only GetCallerIdentity, answered from the fixed USERS table.
        res.writeHead(caller ? 200 : 403, { "content-type": "text/xml" });
        res.end(caller ? STS_IDENTITY.get(caller) : STS_DENIED);
        return;
      }
      const op = target.split(".")[1];
      try {
        if (!caller)
          throw new ApiError(
            "UnrecognizedClientException",
            "The security token included in the request is invalid.",
          );
        const input = JSON.parse(body || "{}");
        if (caller.limited)
          throw new ApiError(
            "AccessDeniedException",
            `User: ${caller.arn} is not authorized to perform: codecommit:${op} on resource: arn:aws:codecommit:${region}:${ACCOUNT}:${input.repositoryName ?? "*"} because no identity-based policy allows the codecommit:${op} action`,
          );
        const handler = ops[op];
        if (!handler)
          throw new ApiError("UnknownOperationException", `mock does not implement ${op}`);
        sendJson(res, 200, handler(input, { caller, region }));
      } catch (error) {
        if (error instanceof ApiError)
          sendJson(res, 400, { __type: error.name, message: error.message });
        else
          sendJson(res, 500, { __type: "InternalFailure", message: String(error?.stack ?? error) });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

function newComment(content, authorArn) {
  return {
    commentId: randomUUID(),
    content,
    authorArn,
    creationDate: now(),
    lastModifiedDate: now(),
    deleted: false,
    callerReactions: [],
    reactionCounts: {},
  };
}
