// Zero-dependency MCP stdio server exposing `typecheck` and `run_tests`.
// Runs inside the sandbox via `node typecheck-server.mjs`. Newline-delimited JSON-RPC 2.0.
// Only uses node built-ins so it can be injected without installing anything.
import { spawn } from 'node:child_process';

const SERVER_INFO = { name: 'vanguard', version: '0.1.0' };

const TOOLS = [
  {
    name: 'typecheck',
    description: 'Run the project type checker and return its output and exit code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_tests',
    description: 'Run the project test suite and return its output and exit code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_knowledge',
    description: 'Search the project docs/knowledge base for a query before writing code.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_edge_tests',
    description: 'Return the current diff (or a configured command output) as context for writing edge-case tests.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'profile',
    description: 'Run the configured performance benchmark and return its output.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function commandFor(name, args) {
  if (name === 'typecheck') return process.env.MCP_TYPECHECK_CMD ?? 'pnpm typecheck';
  if (name === 'run_tests') return process.env.MCP_TEST_CMD ?? 'pnpm test';
  if (name === 'profile') return process.env.MCP_PROFILE_CMD ?? 'echo "set MCP_PROFILE_CMD to a benchmark command"';
  if (name === 'generate_edge_tests') return process.env.MCP_EDGETEST_CMD ?? 'git --no-pager diff';
  if (name === 'search_knowledge') {
    const dir = process.env.MCP_KNOWLEDGE_DIR ?? 'docs';
    const query = String(args?.query ?? '').replace(/'/g, "'\\''");
    return `grep -rni -- '${query}' '${dir}' || true`;
  }
  return undefined;
}

function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', command], { cwd: process.cwd() });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
    child.on('error', (e) => resolve({ code: 1, out: String(e) }));
  });
}

export async function handleRequest(req, run = runCommand) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const command = commandFor(name, params?.arguments);
    if (command === undefined) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    const { code, out } = await run(command);
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `exit ${code}\n${out}` }], isError: code !== 0 },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function processLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined || req.id === null) return; // notification, no response
  const res = await handleRequest(req);
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

function main() {
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line !== '') chain = chain.then(() => processLine(line));
      nl = buffer.indexOf('\n');
    }
  });
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('typecheck-server.mjs')) {
  main();
}
