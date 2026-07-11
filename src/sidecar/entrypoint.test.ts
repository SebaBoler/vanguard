import { describe, expect, it } from 'vitest';
import { execa } from 'execa';

/**
 * Integration test for the real `vanguard __sidecar` entrypoint — the process wiring the unit test
 * (sidecar.test.ts) cannot reach: args parse → cli/index.ts dispatch → readline over stdin →
 * newline-framed stdout → clean EOF shutdown. Run via tsx against source, so it needs no build and
 * is CI-safe (CI runs tests without `pnpm build`). Uses only Docker-free requests: capabilities,
 * unknown method, malformed JSON, and a createRun that throws at provider validation *before* any
 * sandbox — so this never touches Docker or credentials.
 */
describe('__sidecar entrypoint (integration)', () => {
  it('answers a request sequence over real stdio and exits 0 on EOF', async () => {
    const input =
      [
        '{"id":"1","method":"capabilities"}',
        '{"id":"2","method":"bogus"}',
        '{not json}',
        '', // blank line — must be skipped, not errored
        '{"id":"5","method":"createRun","params":{"issueRef":"gh-1","provider":"notaprovider"}}',
      ].join('\n') + '\n';

    const { stdout, exitCode } = await execa('tsx', ['src/cli/index.ts', '__sidecar'], {
      input,
      preferLocal: true,
    });

    const lines = stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // capabilities: full structured result, id-correlated
    expect(lines[0]).toMatchObject({ id: '1', result: { transports: ['github', 'gitlab', 'linear'] } });
    // unknown method: bad-request error, id-correlated
    expect(lines[1]).toMatchObject({ id: '2', error: { kind: 'bad-request' } });
    // malformed JSON: error with no id (parse fails before id extraction)
    expect(lines[2]).toMatchObject({ error: { message: 'invalid JSON' } });
    // blank line produced no output line — so the createRun reply is lines[3], not lines[4].
    // Unknown provider is now caught at the validation boundary → bad-request.
    expect(lines[3]).toMatchObject({ id: '5', error: { kind: 'bad-request' } });
    expect(lines).toHaveLength(4);
    // clean shutdown once stdin closes
    expect(exitCode).toBe(0);
  }, 30_000);
});
