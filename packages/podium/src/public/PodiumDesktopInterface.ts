import type { DesktopOverviewView } from "./DesktopViewInterface.js";

export interface PodiumDesktopInterface {
  getDesktopOverview(): Promise<DesktopOverviewView>;
}
