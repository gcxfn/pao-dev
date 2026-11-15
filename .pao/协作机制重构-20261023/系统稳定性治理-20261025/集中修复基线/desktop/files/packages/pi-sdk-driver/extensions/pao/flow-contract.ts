import { defineService, type Context } from "@earendil-works/chord";
import type {
  readDesktopEditor,
  previewDesktopWorkflow,
  DesktopProjectSnapshot,
} from "@earendil-works/pi-coding-agent/pao/desktop";
import type { Identity } from "./contract.ts";

export type EditorState = ReturnType<typeof readDesktopEditor> & {
  snapshot: DesktopProjectSnapshot;
};
export type Recipe = EditorState["catalog"]["recipes"][number]["recipe"];
export interface FlowService {
  refresh(context: Context): Promise<EditorState>;
  preview(
    request: Identity & { recipe: Recipe; parameters: Record<string, string> },
    context: Context,
  ): Promise<ReturnType<typeof previewDesktopWorkflow>>;
  save(
    request: Identity & { recipe: Recipe; revision: string | null },
    context: Context,
  ): Promise<void>;
  start(
    request: Identity & {
      recipe: Recipe;
      revision: string;
      parameters: Record<string, string>;
      masterTier: string;
      thinking: string;
    },
    context: Context,
  ): Promise<void>;
  chat(request: Identity & { text: string }, context: Context): Promise<void>;
  control(request: Identity & { params: Record<string, unknown> }, context: Context): Promise<void>;
  template(request: Identity & { id: string; name?: string }, context: Context): Promise<void>;
}
export const Flow = defineService<FlowService>("pao.desktop.flow.v1");
