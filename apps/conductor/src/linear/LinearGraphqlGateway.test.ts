import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionLinearGateway,
  LinearGraphqlGateway,
} from "./LinearGraphqlGateway.js";
import { ROOT_STATE_COMMENT_MARKER } from "./LinearMarkers.js";

type LinearGraphqlTransport = ConstructorParameters<typeof LinearGraphqlGateway>[0];

test("GraphQL gateway validates and normalizes provider issue data", async () => {
  const transport: LinearGraphqlTransport = async (operation) => {
    assert.equal(operation, "GetIssue");
    return {
      data: {
        issue: {
          id: "root-id",
          identifier: "ENG-1",
          title: "Root",
          description: "Original task",
          url: "https://linear.app/acme/issue/ENG-1/root",
          state: { id: "state-active", type: "started" },
          parent: null,
          team: { id: "team-id" },
          creator: { id: "user-id" },
        },
      },
    };
  };

  const gateway = new LinearGraphqlGateway(transport);
  assert.deepEqual(await gateway.get_issue("ENG-1"), {
    id: "root-id",
    identifier: "ENG-1",
    title: "Root",
    description: "Original task",
    url: "https://linear.app/acme/issue/ENG-1/root",
    status: "active",
    status_id: "state-active",
    parent_id: null,
    team_id: "team-id",
    creator_id: "user-id",
  });
});

test("GraphQL gateway implements normalized discovery, projection, and descendant operations", async () => {
  const operations: string[] = [];
  const transport: LinearGraphqlTransport = async (operation, _document, variables) => {
    operations.push(operation);
    if (operation === "ListTeamStates") return {
      data: { workflowStates: { nodes: [
        { id: "state-todo", name: "Todo", type: "unstarted", team: { id: "team-id" } },
        { id: "state-done", name: "Done", type: "completed", team: { id: "team-id" } },
        { id: "state-provider-extension", name: "Provider extension", type: "future_type", team: { id: "team-id" } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } },
    };
    if (operation === "ListIssueComments") return {
      data: { issue: { comments: { nodes: [
        {
          id: "comment-1",
          body: "First input",
          createdAt: "2026-08-05T00:00:00.000Z",
          user: { id: "user-id" },
        }, {
          id: "state-comment",
          body: `${ROOT_STATE_COMMENT_MARKER}\n\nstate`,
          createdAt: "2026-08-05T00:01:00.000Z",
          user: { id: "harness-id" },
        },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    };
    if (operation === "CreateWorkflowState") return {
      data: { workflowStateCreate: { success: true, workflowState: {
        id: "state-review", name: "In Review", type: "started", team: { id: "team-id" },
      } } },
    };
    if (operation === "ListIssueChildren") {
      const issueId = variables.issueRef;
      const nodes = issueId === "root-id"
        ? [{ id: "cycle-id", state: { id: "state-active", type: "started" } }]
        : issueId === "cycle-id"
          ? [{ id: "audit-id", state: { id: "state-done", type: "completed" } }]
          : [];
      return { data: { issue: { children: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    if (operation === "CreateIssue") return {
      data: { issueCreate: { success: true, issue: {
        id: "execute-id",
        identifier: "ENG-4",
        title: "Execute",
        description: "Frozen execute",
        url: "https://linear.app/acme/issue/ENG-4/execute",
        state: { id: "state-todo", type: "unstarted" },
        parent: { id: "cycle-id" },
        team: { id: "team-id" },
        creator: { id: "harness-id" },
      } } },
    };
    if (operation === "UpdateIssueStatus") return { data: { issueUpdate: { success: true } } };
    if (operation === "CreateComment") return { data: { commentCreate: { success: true, comment: {
      id: "execute-result-id",
      body: "Process completed",
      createdAt: "2026-08-05T00:02:00.000Z",
      issue: { id: "execute-id" },
      user: { id: "harness-id" },
    } } } };
    if (operation === "UpdateComment") return { data: { commentUpdate: { success: true } } };
    throw new Error(`unexpected operation ${operation}`);
  };
  const gateway = new LinearGraphqlGateway(transport);

  assert.equal((await gateway.list_team_states("team-id")).length, 3);
  assert.equal((await gateway.create_workflow_state({
    team_id: "team-id", name: "In Review", type: "started", color: "#5E6AD2",
  })).id, "state-review");
  assert.deepEqual(await gateway.list_root_comments_after("root-id", "comment-1"), [{
    id: "state-comment",
    issue_id: "root-id",
    body: `${ROOT_STATE_COMMENT_MARKER}\n\nstate`,
    creator_id: "harness-id",
    created_at: "2026-08-05T00:01:00.000Z",
  }]);
  assert.equal((await gateway.find_root_state_comment("root-id"))?.id, "state-comment");
  assert.deepEqual(await gateway.list_unfinished_descendants("root-id"), [
    { id: "cycle-id", status: "active" },
  ]);
  assert.equal((await gateway.create_issue({
    team_id: "team-id",
    parent_id: "cycle-id",
    title: "Execute",
    description: "Frozen execute",
    status_id: "state-todo",
  })).id, "execute-id");
  await gateway.update_issue_status("execute-id", "state-done");
  assert.equal((await gateway.create_comment("execute-id", "Process completed")).id, "execute-result-id");
  await gateway.update_comment("execute-result-id", "Process completed in 10ms");

  assert.deepEqual(operations, [
    "ListTeamStates",
    "CreateWorkflowState",
    "ListIssueComments",
    "ListIssueComments",
    "ListIssueChildren",
    "ListIssueChildren",
    "ListIssueChildren",
    "CreateIssue",
    "UpdateIssueStatus",
    "CreateComment",
    "UpdateComment",
  ]);
});

test("GraphQL gateway rejects malformed responses without exposing provider payloads", async () => {
  const privateProviderDetail = "private-provider-payload-detail";
  const gateway = new LinearGraphqlGateway(async () => ({
    data: { issue: { id: privateProviderDetail } },
  }));

  await assert.rejects(gateway.get_issue("ENG-1"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^linear_get_issue_invalid_response:ENG-1$/u);
    assert.equal(error.message.includes(privateProviderDetail), false);
    return true;
  });
});

test("GraphQL gateway preserves the current provider message while rejecting malformed envelopes", async () => {
  const malformed = new LinearGraphqlGateway(async () => ({ data: null }));
  await assert.rejects(
    malformed.get_issue("ENG-1"),
    /^Error: linear_get_issue_invalid_response:ENG-1$/u,
  );

  const rejected = new LinearGraphqlGateway(async () => ({
    errors: [{ message: "private-provider-error-detail" }],
  }));
  await assert.rejects(
    rejected.get_issue("ENG-1"),
    /^Error: private-provider-error-detail$/u,
  );
});

test("GraphQL gateway preserves the current transport error without wrapping or cause traversal", async () => {
  const transportError = new Error(
    "fetch failed",
    { cause: new Error("Connect Timeout Error with private connection context") },
  );
  const gateway = new LinearGraphqlGateway(async () => {
    throw transportError;
  });

  await assert.rejects(gateway.update_issue_status("issue-id", "state-done"), (error: unknown) => {
    assert.equal(error, transportError);
    assert.equal((error as Error).message, "fetch failed");
    return true;
  });
});

test("GraphQL gateway bounds a provider call that never settles", async () => {
  const gateway = new LinearGraphqlGateway(
    async () => new Promise<never>(() => undefined),
    1,
  );

  await assert.rejects(
    gateway.get_issue("ENG-1"),
    /^Error: timeout$/u,
  );
});

test("production GraphQL factory fails closed when LINEAR_API_KEY is absent", () => {
  assert.throws(
    () => createProductionLinearGateway({}),
    /linear_api_key_missing/u,
  );
});

test("GraphQL gateway uploads JSON bytes and returns the uploaded asset URL", async (context) => {
  const operations: Array<{
    name: string;
    variables: Readonly<Record<string, unknown>>;
  }> = [];
  const contents = new TextEncoder().encode('{"ok":true}\n');
  const originalFetch = globalThis.fetch;
  let uploadRequest: { input: RequestInfo | URL; init: RequestInit | undefined } | undefined;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    uploadRequest = { input, init };
    return new Response("uploaded", { status: 200 });
  };

  const gateway = new LinearGraphqlGateway(async (operation, _document, variables) => {
    operations.push({ name: operation, variables });
    if (operation === "FileUpload") return {
      data: { fileUpload: { success: true, uploadFile: {
        uploadUrl: "https://uploads.linear.app/signed-upload",
        assetUrl: "https://uploads.linear.app/assets/report.json",
        headers: [
          { key: "x-goog-meta-token", value: "signed" },
          { key: "Content-Type", value: "application/json" },
        ],
      } } },
    };
    throw new Error(`unexpected operation ${operation}`);
  });

  assert.deepEqual(
    await gateway.upload_file("report.json", "application/json", contents),
    { url: "https://uploads.linear.app/assets/report.json" },
  );
  assert.deepEqual(operations, [
    {
      name: "FileUpload",
      variables: { contentType: "application/json", filename: "report.json", size: contents.byteLength },
    },
  ]);
  assert.ok(uploadRequest);
  assert.equal(uploadRequest?.input?.toString(), "https://uploads.linear.app/signed-upload");
  assert.equal(uploadRequest?.init?.method, "PUT");
  assert.equal(uploadRequest?.init?.headers instanceof Headers, true);
  const headers = new Headers(uploadRequest?.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("cache-control"), "public, max-age=31536000");
  assert.equal(headers.get("x-goog-meta-token"), "signed");
  assert.ok(uploadRequest?.init?.body instanceof Uint8Array);
  assert.deepEqual([...((uploadRequest?.init?.body as Uint8Array) ?? [])], [...contents]);
});

test("GraphQL gateway rejects unsupported upload content types before requesting a signed URL", async () => {
  let called = false;
  const gateway = new LinearGraphqlGateway(async () => {
    called = true;
    return {};
  });

  await assert.rejects(
    gateway.upload_file("report.md", "text/markdown" as never, new Uint8Array([1])),
    /^Error: linear_upload_content_type_invalid$/u,
  );
  assert.equal(called, false);
});

test("GraphQL gateway rejects non-HTTPS upload URLs before sending bytes", async (context) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };
  const gateway = new LinearGraphqlGateway(async () => ({
    data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: "http://uploads.linear.app/signed-upload",
      assetUrl: "https://uploads.linear.app/assets/report.json",
      headers: [],
    } } },
  }));

  await assert.rejects(
    gateway.upload_file("report.json", "application/json", new Uint8Array([1])),
    /^Error: invalid$/u,
  );
  assert.equal(called, false);
});

test("GraphQL gateway rejects sensitive or duplicate upload headers", async () => {
  const cases = [
    [{ key: "Authorization", value: "secret" }],
    [{ key: "x-upload", value: "one" }, { key: "X-Upload", value: "two" }],
  ];
  for (const headers of cases) {
    const gateway = new LinearGraphqlGateway(async () => ({
      data: { fileUpload: { success: true, uploadFile: {
        uploadUrl: "https://uploads.linear.app/signed-upload",
        assetUrl: "https://uploads.linear.app/assets/report.json",
        headers,
      } } },
    }));
    await assert.rejects(
      gateway.upload_file("report.json", "application/json", new Uint8Array([1])),
      /^Error: invalid$/u,
    );
  }
});

test("GraphQL gateway preserves direct upload errors", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const providerError = new Error("provider upload failed");
  const providerFailure = new LinearGraphqlGateway(async () => { throw providerError; });
  await assert.rejects(
    providerFailure.upload_file("report.json", "application/json", new Uint8Array([1])),
    (error: unknown) => error === providerError,
  );

  const putError = new Error("put upload failed");
  globalThis.fetch = async () => { throw putError; };
  const putFailure = new LinearGraphqlGateway(async () => ({
    data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: "https://uploads.linear.app/signed-upload",
      assetUrl: "https://uploads.linear.app/assets/report.json",
      headers: [],
    } } },
  }));
  await assert.rejects(
    putFailure.upload_file("report.json", "application/json", new Uint8Array([1])),
    (error: unknown) => error === putError,
  );
});

test("GraphQL gateway bounds the PUT response and aborts timed-out uploads", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const transport: LinearGraphqlTransport = async () => ({
    data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: "https://uploads.linear.app/signed-upload",
      assetUrl: "https://uploads.linear.app/assets/report.json",
      headers: [],
    } } },
  });
  globalThis.fetch = async () => new Response("x".repeat(64 * 1024 + 1), { status: 200 });
  const oversizedResponse = new LinearGraphqlGateway(transport);
  await assert.rejects(
    oversizedResponse.upload_file("report.json", "application/json", new Uint8Array([1])),
    /^Error: upload response too large$/u,
  );

  let aborted = false;
  globalThis.fetch = async (_input, init) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; });
    return new Promise<never>(() => undefined);
  };
  const timedOut = new LinearGraphqlGateway(transport, 1);
  await assert.rejects(
    timedOut.upload_file("report.json", "application/json", new Uint8Array([1])),
    /^Error: timeout$/u,
  );
  assert.equal(aborted, true);
});

test("GraphQL gateway rejects failed or malformed fileUpload payloads", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(null, { status: 200 });
  for (const fileUpload of [
    { success: false, uploadFile: null },
    { success: true, uploadFile: null },
    { success: true, uploadFile: { uploadUrl: "https://uploads.linear.app/signed-upload", assetUrl: null, headers: [] } },
  ]) {
    const gateway = new LinearGraphqlGateway(async () => ({ data: { fileUpload } }));
    await assert.rejects(
      gateway.upload_file("report.json", "application/json", new Uint8Array([1])),
      /^Error: invalid$/u,
    );
  }
});

test("GraphQL gateway rejects a non-2xx PUT without exposing response text", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("private provider response", {
    status: 502,
    statusText: "provider detail must stay private",
  });
  const gateway = new LinearGraphqlGateway(async () => ({
    data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: "https://uploads.linear.app/signed-upload",
      assetUrl: "https://uploads.linear.app/assets/report.json",
      headers: [],
    } } },
  }));

  await assert.rejects(
    gateway.upload_file("report.json", "application/json", new Uint8Array([1])),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "HTTP 502");
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
});
