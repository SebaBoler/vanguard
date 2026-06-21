/**
 * Unit tests for per-exec stage secrets delivered via tmpfs (stdin-written, sourced, removed).
 * Uses vi.mock('execa') so NO real docker is needed — we capture every execa call's argv.
 */
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// ---- mock execa BEFORE importing docker.ts ----
vi.mock('execa', () => {
  const execaMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  return { execa: execaMock };
});

import { execa } from 'execa';
import { DockerSandboxProvider } from './docker.js';
import { SandboxError } from '../core/errors.js';

const SECRETS_DIR = '/run/vanguard';
const STAGE_SECRETS_FILE = `${SECRETS_DIR}/stage.env`;
const SECRETS_FILE = `${SECRETS_DIR}/secrets.env`;

function mockedExeca(): MockInstance {
  return execa as unknown as MockInstance;
}

/** Collect all argv arrays from every execa('docker', [...], ...) call */
function capturedArgvArrays(): string[][] {
  return mockedExeca()
    .mock.calls.filter((c: unknown[]) => c[0] === 'docker')
    .map((c: unknown[]) => c[1] as string[]);
}

/** Build a started-looking provider without actually running docker start(). */
async function makeStartedProvider(config: ConstructorParameters<typeof DockerSandboxProvider>[0] = {}): Promise<DockerSandboxProvider> {
  const provider = new DockerSandboxProvider(config);
  // start() calls execa; let it run so we can track all subsequent exec calls separately
  await provider.start();
  return provider;
}

describe('DockerSandboxProvider per-exec stage secrets', () => {
  beforeEach(() => {
    mockedExeca().mockReset();
    // Default: return success for all calls
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('TEST 1 — ARGV LEAK: secret value never appears in any execa argv, and stage file is written via stdin', async () => {
    const provider = await makeStartedProvider({ secretsMode: 'tmpfs' });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await provider.exec('printenv', { secrets: { TOK: 's3cr3t-value' } });

    const allArgvs = capturedArgvArrays();

    // Assert NO argv element contains the secret value
    for (const argv of allArgvs) {
      for (const arg of argv) {
        expect(arg).not.toContain('s3cr3t-value');
      }
    }

    // Assert NO argv element looks like -e TOK=<secret>
    for (const argv of allArgvs) {
      const eFlag = argv.indexOf('-e');
      if (eFlag >= 0) {
        expect(argv[eFlag + 1]).not.toMatch(/^TOK=/);
      }
    }

    // Assert that the write call uses docker exec -i <name> sh -c 'umask 077; cat > <file>'
    // with the secret value as stdin input, not as argv
    const writeCall = mockedExeca().mock.calls.find((c: unknown[]) => {
      const args = c[1] as string[];
      return (
        c[0] === 'docker' &&
        args[0] === 'exec' &&
        args[1] === '-i' &&
        args.includes('sh') &&
        args.includes('-c') &&
        args[args.indexOf('-c') + 1]?.includes('umask 077') &&
        args[args.indexOf('-c') + 1]?.includes(STAGE_SECRETS_FILE)
      );
    });
    expect(writeCall).toBeDefined();
    // The options (3rd argument) should have 'input' containing the secret
    const writeOptions = (writeCall as unknown[])[2] as { input?: string };
    expect(writeOptions.input).toContain('s3cr3t-value');
    // But the argv itself must not contain the secret
    const writeArgv = (writeCall as unknown[])[1] as string[];
    for (const arg of writeArgv) {
      expect(arg).not.toContain('s3cr3t-value');
    }
  });

  it('TEST 2 — CLEANUP: rm -f stage.env is called after exec', async () => {
    const provider = await makeStartedProvider({ secretsMode: 'tmpfs' });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await provider.exec('echo hi', { secrets: { TOKEN: 'mytoken' } });

    const allArgvs = capturedArgvArrays();
    const rmCall = allArgvs.find(
      (argv) =>
        argv[0] === 'exec' &&
        argv.includes('sh') &&
        argv.includes('-c') &&
        argv[argv.indexOf('-c') + 1]?.includes(`rm -f ${STAGE_SECRETS_FILE}`),
    );
    expect(rmCall).toBeDefined();
  });

  it('TEST 3 — CLEANUP ON THROW: rm -f is called even when the main exec rejects', async () => {
    const provider = await makeStartedProvider({ secretsMode: 'tmpfs' });
    mockedExeca().mockReset();

    mockedExeca().mockImplementation((_cmd: string, args: string[]) => {
      // Stage-file write call (exec -i … umask 077 … cat > stage.env) — succeed
      if (args[0] === 'exec' && args[1] === '-i') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      // Cleanup rm call — succeed so it doesn't hide the original error
      const shCmdIdx = args.indexOf('-c');
      if (shCmdIdx >= 0 && (args[shCmdIdx + 1] ?? '').includes('rm -f')) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      // Main exec (sh -lc <wrapped>) — REJECT to prove finally branch fires
      if (args.includes('-lc')) {
        return Promise.reject(new Error('docker exec failed'));
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // exec() must rethrow the rejection
    await expect(provider.exec('fail-cmd', { secrets: { KEY: 'val' } })).rejects.toThrow('docker exec failed');

    // Cleanup rm -f must still have been called (finally branch)
    const allCalls = mockedExeca().mock.calls as Array<[string, string[], unknown]>;
    const rmCall = allCalls.find((c) => {
      const args = c[1] as string[];
      const shCmdIdx = args.indexOf('-c');
      return (
        c[0] === 'docker' &&
        shCmdIdx >= 0 &&
        (args[shCmdIdx + 1] ?? '').includes(`rm -f ${STAGE_SECRETS_FILE}`)
      );
    });
    expect(rmCall).toBeDefined();
  });

  it('TEST 4 — ENV-FILE REJECT: secrets with secretsMode "env-file" throws SandboxError', async () => {
    const provider = await makeStartedProvider({ secretsMode: 'env-file' });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await expect(
      provider.exec('echo hi', { secrets: { TOKEN: 'abc' } }),
    ).rejects.toThrow(SandboxError);

    await expect(
      provider.exec('echo hi', { secrets: { TOKEN: 'abc' } }),
    ).rejects.toThrow(/tmpfs/i);
  });

  it('TEST 5 — WRAP SOURCES STAGE FILE: main exec command sources the stage env file', async () => {
    const provider = await makeStartedProvider({ secretsMode: 'tmpfs' });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await provider.exec('echo hello', { secrets: { KEY: 'value' } });

    // Find the main exec call (has -lc, not the write call with -i, not the rm cleanup)
    const allCalls = mockedExeca().mock.calls as Array<[string, string[], unknown]>;
    const mainExecCall = allCalls.find((c) => {
      const args = c[1];
      return (
        c[0] === 'docker' &&
        args[0] === 'exec' &&
        args.includes('-lc')
      );
    });

    expect(mainExecCall).toBeDefined();
    if (mainExecCall === undefined) return;
    const args = mainExecCall[1];
    const lcIdx = args.indexOf('-lc');
    const wrappedCommand = args[lcIdx + 1];
    // The wrapped command must source the stage file
    expect(wrappedCommand).toContain(`[ -f ${STAGE_SECRETS_FILE} ] && . ${STAGE_SECRETS_FILE}`);
  });

  it('TEST 5b — WRAP SOURCES STAGE FILE even when run-level secrets also exist', async () => {
    // Provider with run-level secrets (tmpfs mode) + per-exec secrets
    const provider = await makeStartedProvider({
      secretsMode: 'tmpfs',
      secrets: { RUN_KEY: 'run-val' },
    });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await provider.exec('echo hello', { secrets: { EXEC_KEY: 'exec-val' } });

    const allCalls = mockedExeca().mock.calls as Array<[string, string[], unknown]>;
    const mainExecCall = allCalls.find((c) => {
      const args = c[1];
      return c[0] === 'docker' && args[0] === 'exec' && args.includes('-lc');
    });

    expect(mainExecCall).toBeDefined();
    if (mainExecCall === undefined) return;
    const args = mainExecCall[1];
    const lcIdx = args.indexOf('-lc');
    const wrappedCommand = args[lcIdx + 1];
    // Must source BOTH the run-level secrets file AND the stage file
    expect(wrappedCommand).toContain(`[ -f ${SECRETS_FILE} ] && . ${SECRETS_FILE}`);
    expect(wrappedCommand).toContain(`[ -f ${STAGE_SECRETS_FILE} ] && . ${STAGE_SECRETS_FILE}`);
  });

  // ---- FIX 1 regression --------------------------------------------------
  it('FIX 1 REGRESSION — tmpfs mount present even with no constructor secrets', async () => {
    // No secrets at all — tmpfs dir must still be mounted so per-exec secrets have somewhere to land.
    const provider = new DockerSandboxProvider({ secretsMode: 'tmpfs' });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await provider.start();

    const allArgvs = capturedArgvArrays();
    // Find the docker run call
    const runArgv = allArgvs.find((argv) => argv[0] === 'run');
    expect(runArgv).toBeDefined();
    if (runArgv === undefined) return; // narrows type; expect above already fails the test
    // --tmpfs /run/vanguard must appear even with no run-level secrets
    const tmpfsIdx = runArgv.indexOf('--tmpfs');
    expect(tmpfsIdx).toBeGreaterThan(-1);
    expect(runArgv[tmpfsIdx + 1]).toContain(SECRETS_DIR);
  });

  // ---- FIX 2 regressions -------------------------------------------------
  it('FIX 2 REGRESSION — no-secret exec does NOT source stage.env (prevents stale-file bleed)', async () => {
    const provider = await makeStartedProvider({ secretsMode: 'tmpfs' });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    // exec with no secrets option
    await provider.exec('echo hello');

    const allCalls = mockedExeca().mock.calls as Array<[string, string[], unknown]>;
    const mainExecCall = allCalls.find((c) => {
      const args = c[1] as string[];
      return c[0] === 'docker' && args[0] === 'exec' && args.includes('-lc');
    });
    expect(mainExecCall).toBeDefined();
    if (mainExecCall === undefined) return;
    const lcIdx = (mainExecCall[1] as string[]).indexOf('-lc');
    const wrappedCommand = (mainExecCall[1] as string[])[lcIdx + 1];
    // Stage file must NOT be sourced — no secrets were written for this exec
    expect(wrappedCommand).not.toContain('stage.env');
  });

  it('FIX 2 REGRESSION — exec WITH secrets DOES source stage.env', async () => {
    const provider = await makeStartedProvider({ secretsMode: 'tmpfs' });
    mockedExeca().mockReset();
    mockedExeca().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await provider.exec('echo hello', { secrets: { MY_KEY: 'my-val' } });

    const allCalls = mockedExeca().mock.calls as Array<[string, string[], unknown]>;
    const mainExecCall = allCalls.find((c) => {
      const args = c[1] as string[];
      return c[0] === 'docker' && args[0] === 'exec' && args.includes('-lc');
    });
    expect(mainExecCall).toBeDefined();
    if (mainExecCall === undefined) return;
    const lcIdx = (mainExecCall[1] as string[]).indexOf('-lc');
    const wrappedCommand = (mainExecCall[1] as string[])[lcIdx + 1];
    // Stage file MUST be sourced because this exec wrote one
    expect(wrappedCommand).toContain(`[ -f ${STAGE_SECRETS_FILE} ] && . ${STAGE_SECRETS_FILE}`);
  });
});
