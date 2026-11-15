import { desktopIpc } from "../../contracts/ipc";
import type { WorkboardQuery } from "../platform/pao/workboard-query";
import type { MainFrameHandler } from "./main-frame-ipc";
import { expectNoInput } from "./request-validation";

export type WorkboardRequestsOwner = Pick<WorkboardQuery, "collect">;

export function registerWorkboardRequests(
  handle: MainFrameHandler,
  owner: WorkboardRequestsOwner,
): void {
  handle(desktopIpc.getWorkboard, expectNoInput, () => owner.collect());
}
