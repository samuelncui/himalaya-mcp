import { createServer as createHttpServer } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  specTypeSchemas,
  Server,
  type CallToolResult,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { AdapterError, type CallInput, type RunResult, type ToolDefinition } from './types.js';

/** Protocol plumbing only. Validation, execution, and artifact ownership belong to Runtime. */
export interface McpRuntime {
  tools(): ToolDefinition[];
  callTool(name: string, input: CallInput): Promise<RunResult>;
  listResources(): Resource[];
  readResource(uri: string): Promise<ReadResourceResult>;
  close(): Promise<void>;
}

export interface RunningServer {
  close(): Promise<void>;
  done: Promise<void>;
  url?: string;
}

// Base64 attachments count toward this wire limit; native/backend size limits still apply.
export const MAX_MCP_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Only deliberate adapter errors are safe to display; arbitrary exceptions may contain inputs. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof AdapterError)) return 'internal_error: Internal adapter error.';
  return `${error.code}: ${error.message}${error.nextStep ? `\nNext step: ${error.nextStep}` : ''}`;
}

export function createMcpServer(runtime: McpRuntime, version: string): Server {
  const server = new Server(
    { name: 'himalaya-mcp', version },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: runtime.tools().map((tool) => {
      const parsed = specTypeSchemas.Tool['~standard'].validate(tool);
      if (parsed.issues)
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'Invalid generated tool definition.',
        );
      return parsed.value;
    }),
  }));
  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
    try {
      const result = await runtime.callTool(request.params.name, request.params.arguments ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.exitCode !== 0 || result.timedOut === true,
      };
    } catch (error) {
      return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
    }
  });
  server.setRequestHandler('resources/list', () => ({ resources: runtime.listResources() }));
  server.setRequestHandler('resources/read', async (request) => {
    try {
      return await runtime.readResource(request.params.uri);
    } catch (error) {
      if (error instanceof AdapterError)
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, errorMessage(error));
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'Internal adapter error.');
    }
  });
  return server;
}

export function startStdio(
  runtime: McpRuntime,
  options: { version: string; input?: Readable; output?: Writable },
): RunningServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const transport = new StdioServerTransport(input, output, {
    maxBufferSize: MAX_MCP_MESSAGE_BYTES,
  });
  const handle = serveStdio(() => createMcpServer(runtime, options.version), {
    transport,
    onerror: () => {
      process.stderr.write('MCP stdio transport error.\n');
      void close().catch(() => undefined);
    },
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onEnd);
      try {
        // Abort native children even if the protocol transport itself cannot close.
        await closeOwned([handle.close(), runtime.close()]);
        resolveDone();
      } catch (error) {
        rejectDone(error);
        throw error;
      }
    })();
    return closing;
  };
  const onEnd = (): void => {
    void close().catch(() => undefined);
  };
  input.once('end', onEnd);
  input.once('close', onEnd);
  input.once('error', onEnd);
  if (input.readableEnded || input.destroyed) void close().catch(() => undefined);
  return { close, done };
}

export async function startHttp(
  runtime: McpRuntime,
  options: { version: string; host?: string; port?: number },
): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const allowedHosts = ['localhost', '127.0.0.1', '[::1]'];
  // A wildcard bind is not an instruction to trust arbitrary Host/Origin headers.
  if (host !== '0.0.0.0' && host !== '::')
    allowedHosts.push(host.includes(':') ? `[${host}]` : host);
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedHosts);
  const handler = createMcpHandler(() => createMcpServer(runtime, options.version), {
    maxRequestBodySize: MAX_MCP_MESSAGE_BYTES,
    onerror: () => {
      process.stderr.write('MCP HTTP transport error.\n');
    },
  });
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: MAX_MCP_MESSAGE_BYTES,
    onerror: () => {
      process.stderr.write('MCP HTTP transport error.\n');
    },
  });
  const http = createHttpServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    if (request.url?.split('?')[0] !== '/mcp') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found.');
      return;
    }
    // The SDK documents IncomingMessage support; its optional fields predate exactOptionalPropertyTypes.
    void nodeHandler(request as Parameters<typeof nodeHandler>[0], response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('MCP transport error.');
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, host, () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch {
    await handler.close();
    throw new AdapterError(
      'listen_failed',
      'Could not start the MCP HTTP listener.',
      'Check --host and --port.',
    );
  }
  const address = http.address();
  if (!address || typeof address === 'string') {
    await handler.close();
    http.close();
    throw new AdapterError('listen_failed', 'The MCP HTTP listener has no TCP address.');
  }
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => {
        http.close(() => {
          resolve();
        });
      });
      try {
        try {
          await closeOwned([handler.close(), runtime.close()]);
        } finally {
          http.closeAllConnections();
          await stopped;
        }
        resolveDone();
      } catch (error) {
        rejectDone(error);
        throw error;
      }
    })();
    return closing;
  };
  http.on('error', () => {
    process.stderr.write('MCP HTTP listener error.\n');
    void close().catch(() => undefined);
  });
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return { close, done, url: `http://${urlHost}:${address.port}/mcp` };
}

async function closeOwned(closures: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(closures);
  if (results.some((result) => result.status === 'rejected')) {
    throw new AdapterError(
      'shutdown_failed',
      'Could not fully close the MCP connection or native workspaces.',
      'Inspect the server process and private workspace directory.',
    );
  }
}
