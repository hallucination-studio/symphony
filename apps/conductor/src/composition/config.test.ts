import assert from "node:assert/strict";
import test from "node:test";

import { parseConductorConfig } from "./config.js";

const config = {
  linear_team_id: "team:1",
  program_data_path: "/var/lib/symphony",
  performer_home: "/Users/example/.codex",
  codex_executable: "/usr/local/bin/codex",
  delivery_provider_endpoint: "https://api.github.example",
  root_routing: [
    { root_id: "LIN-1", repository_id: "repo:1", repository_path: "/srv/repo", base_branch: "main" },
  ],
};

test("configuration accepts only approved static integration fields", () => {
  assert.equal(parseConductorConfig(config).root_routing[0]?.repository_id, "repo:1");
  for (const secretKey of ["token", "api_key", "client_secret", "profile"]) {
    assert.throws(() => parseConductorConfig({ ...config, [secretKey]: "do-not-log" }), /invalid_contract_keys/u);
  }
  assert.throws(() => parseConductorConfig({ ...config, root_routing: [] }), /invalid_root_routing/u);
});
