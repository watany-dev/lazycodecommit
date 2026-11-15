import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
} from "@aws-sdk/client-codebuild";
import { CodePipelineClient, ListPipelineExecutionsCommand } from "@aws-sdk/client-codepipeline";
import { clientConfig } from "./codecommit.js";
import { consoleHost } from "./console.js";

export type CiProvider = "codebuild" | "codepipeline";

/** One CodeBuild build or CodePipeline execution, flattened (ADR 0010). */
export interface CiRun {
  readonly id: string;
  /** The provider's own status: buildStatus, or the execution's status. */
  readonly status: string;
  /** The commit IDs it ran on: resolvedSourceVersion, or every sourceRevisions[].revisionId. */
  readonly commits: readonly string[];
  readonly startedAt: Date | undefined;
  readonly endedAt: Date | undefined;
  readonly url: string;
}

export interface CiApi {
  /** The project's newest builds, newest first. */
  recentBuilds(project: string, limit: number): Promise<CiRun[]>;
  /** The pipeline's newest executions, newest first. */
  recentExecutions(pipeline: string, limit: number): Promise<CiRun[]>;
}

const console = (region: string, path: string) =>
  `https://${consoleHost(region)}/codesuite/${path}?region=${region}`;

export function buildUrl(region: string, arn: string, project: string, id: string): string {
  // arn:aws:codebuild:<region>:<account>:build/<project>:<uuid>
  const account = arn.split(":")[4] ?? "";
  return console(
    region,
    `codebuild/${account}/projects/${encodeURIComponent(project)}/build/${encodeURIComponent(id)}/`,
  );
}

export function executionUrl(region: string, pipeline: string, id: string): string {
  return console(
    region,
    `codepipeline/pipelines/${encodeURIComponent(pipeline)}/executions/${encodeURIComponent(id)}/timeline`,
  );
}

export function createCiApi(options: { region?: string; profile?: string }): CiApi {
  const config = clientConfig(options);
  const build = new CodeBuildClient(config);
  const pipeline = new CodePipelineClient(config);

  return {
    async recentBuilds(project, limit) {
      const list = await build.send(
        new ListBuildsForProjectCommand({ projectName: project, sortOrder: "DESCENDING" }),
      );
      const ids = (list.ids ?? []).slice(0, limit);
      if (ids.length === 0) return [];
      const [out, region] = await Promise.all([
        build.send(new BatchGetBuildsCommand({ ids })),
        build.config.region(),
      ]);
      // BatchGetBuilds does not keep the order of ids.
      const byId = new Map((out.builds ?? []).map((b) => [b.id, b]));
      return ids.flatMap((id) => {
        const b = byId.get(id);
        if (!b) return [];
        return [
          {
            id,
            status: b.buildStatus ?? "",
            commits: b.resolvedSourceVersion ? [b.resolvedSourceVersion] : [],
            startedAt: b.startTime,
            endedAt: b.endTime,
            url: buildUrl(region, b.arn ?? "", project, id),
          },
        ];
      });
    },

    async recentExecutions(name, limit) {
      const [out, region] = await Promise.all([
        pipeline.send(new ListPipelineExecutionsCommand({ pipelineName: name, maxResults: limit })),
        pipeline.config.region(),
      ]);
      return (out.pipelineExecutionSummaries ?? []).flatMap((e) => {
        if (!e.pipelineExecutionId) return [];
        return [
          {
            id: e.pipelineExecutionId,
            status: e.status ?? "",
            commits: (e.sourceRevisions ?? []).flatMap((r) => (r.revisionId ? [r.revisionId] : [])),
            startedAt: e.startTime,
            // The summary has no end time; lastUpdateTime is when it reached its final status.
            endedAt:
              e.status === "InProgress" || e.status === "Stopping" ? undefined : e.lastUpdateTime,
            url: executionUrl(region, name, e.pipelineExecutionId),
          },
        ];
      });
    },
  };
}
