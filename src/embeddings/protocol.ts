// Shared types for the embedding daemon <-> client IPC.
// Newline-delimited JSON over Unix socket.

export type EmbedKind = "document" | "query";

export interface EmbedRequest {
  op: "embed";
  id: string;
  kind: EmbedKind;
  text: string;
}

export interface EmbedResponse {
  id: string;
  embedding?: number[];
  error?: string;
}

export interface PingRequest {
  op: "ping";
  id: string;
}

export interface PingResponse {
  id: string;
  ready: boolean;
  model?: string;
  dims?: number;
  error?: string;
}

export type DaemonRequest = EmbedRequest | PingRequest;
export type DaemonResponse = EmbedResponse | PingResponse;

export const DEFAULT_SOCKET_DIR = "/tmp";
export const DEFAULT_MODEL_REPO = "nomic-ai/nomic-embed-text-v1.5";
export const DEFAULT_DTYPE = "q8";
export const DEFAULT_DIMS = 768;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
// Generous enough that the first embed after a daemon spawn — when the nomic
// pipeline is still warming up — does not silently time out. A 200ms cap was
// short enough that any not-yet-warm daemon returned null and the row landed
// with NULL in the embedding column.
export const DEFAULT_CLIENT_TIMEOUT_MS = 2000;
export const DOC_PREFIX = "search_document: ";
export const QUERY_PREFIX = "search_query: ";

export function socketPathFor(uid: number | string, dir = DEFAULT_SOCKET_DIR): string {
  return `${dir}/hivemind-embed-${uid}.sock`;
}

export function pidPathFor(uid: number | string, dir = DEFAULT_SOCKET_DIR): string {
  return `${dir}/hivemind-embed-${uid}.pid`;
}
