import { decodePodiumClientDesktopOverviewView } from "../contracts-runtime.mjs";

import type {
  DesktopOverviewInput,
  DesktopOverviewView,
  DesktopViewInterface,
  JsonValue,
} from "../../public/DesktopViewInterface.js";

export class PodiumDesktopViewImpl implements DesktopViewInterface {
  overview(input: DesktopOverviewInput): DesktopOverviewView {
    const view = {
      linear_connection: input.linear_connection,
      projects: input.projects,
      conductors: input.conductors,
      recent_logs: input.logs,
      observed_at: input.now,
    };
    return decodePodiumClientDesktopOverviewView(view) as JsonValue;
  }
}
