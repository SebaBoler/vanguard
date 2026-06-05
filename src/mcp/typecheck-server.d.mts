export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export type CommandRunner = (command: string) => Promise<{ code: number; out: string }>;

export function handleRequest(req: JsonRpcRequest, run?: CommandRunner): Promise<JsonRpcResponse>;
