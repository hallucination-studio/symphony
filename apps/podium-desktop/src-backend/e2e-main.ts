import {
  createE2EPodiumServiceComposition,
} from "@symphony/podium/e2e";

import {
  runPodiumBackendEntrypoint,
  type PodiumBackendCompositionFactory,
} from "./main.js";

const createE2EComposition: PodiumBackendCompositionFactory = async ({
  environment,
}) => {
  const composition = await createE2EPodiumServiceComposition({
    linearClientId: required(
      environment.LINEAR_CLIENT_ID,
      "e2e_linear_client_id_missing",
    ),
    linearClientSecret: required(
      environment.LINEAR_CLIENT_SECRET,
      "e2e_linear_client_secret_missing",
    ),
    projectSlug: required(
      environment.SYMPHONY_E2E_PROJECT_SLUG,
      "e2e_linear_project_slug_missing",
    ),
    projectName: required(
      environment.SYMPHONY_E2E_EXPECTED_PROJECT_NAME,
      "e2e_linear_project_name_missing",
    ),
  });
  return {
    conductorServices: composition.conductorServices,
    createClientServices: (host) =>
      composition.createClientServices(host),
    close: () => composition.close(),
  };
};

function required(value: string | undefined, code: string): string {
  if (!value || value.length > 4096 || /[\r\n\0]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

runPodiumBackendEntrypoint(createE2EComposition);
