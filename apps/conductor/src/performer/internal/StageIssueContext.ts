import { LinearClient } from "@linear/sdk";

import { parseBoundedString } from "../../contracts/validation.js";

export interface StageIssueContext {
  readonly title: string;
  readonly description: string;
}

export class LinearStageIssueContextReader {
  constructor(private readonly client: LinearClient, private readonly teamId: string) {}

  async read(issueId: string): Promise<StageIssueContext> {
    const issue = await this.client.issue(issueId);
    if (issue.id !== issueId || issue.teamId !== this.teamId) throw new Error("linear_issue_context_identity_mismatch");
    return Object.freeze({
      title: parseBoundedString(issue.title, "invalid_issue_title", 200),
      description: parseBoundedString(issue.description, "invalid_issue_description", 4000),
    });
  }
}
