import type { SessionRef, SessionStatus, Timestamp } from "./types.js";

export type SideChatMessageRole = "user" | "assistant";

export interface SideChatErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
}

export interface SideChatMessage {
  readonly id: string;
  readonly role: SideChatMessageRole;
  readonly text: string;
  readonly createdAt: Timestamp;
  readonly status: "complete" | "error";
  readonly error?: SideChatErrorInfo;
}

/**
 * Describes the source session context captured for a side-chat request.
 * A running source or unreadable source data is represented as a partial
 * context, instead of being treated as a complete snapshot.
 */
export interface SideChatSyncState {
  readonly boundaryId: string | null;
  readonly sourceStatus: SessionStatus;
  readonly capturedAt: Timestamp;
  readonly contextComplete: boolean;
  readonly limitations: readonly string[];
}

export interface SideChatSnapshot {
  readonly source: SessionRef;
  readonly messages: readonly SideChatMessage[];
  readonly updatedAt: Timestamp;
  readonly sync: SideChatSyncState;
  /** 当前是否有一轮辅助问答正在生成。 */
  readonly busy: boolean;
  readonly error?: SideChatErrorInfo;
  readonly readOnly: true;
  readonly toolNames: readonly string[];
}

export interface SendSideChatMessageInput {
  readonly source: SessionRef;
  readonly text: string;
}
