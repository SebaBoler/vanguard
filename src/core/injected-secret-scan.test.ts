import { afterEach, describe, expect, it, vi } from 'vitest';
import { injectedSecretValues, renderSecretBlockComment, scanForInjectedSecrets } from './secret-scan.js';
import { scanOutgoingForSecrets } from '../runners/deliver-change.js';

const credential = 'opaque-credential-92837';
const diff = (line: string, path = 'tests/example.ts'): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n context\n-old\n+${line}\n+tail`;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('injected credential gate', () => {
  it('checks encodings, test paths and allowlist markers without exposing values', () => {
    for (const value of [credential, Buffer.from(credential).toString('base64'), encodeURIComponent(credential)]) {
      expect(scanForInjectedSecrets(diff(`${value} // gitleaks:allow`), [credential])).toEqual([
        { file: 'tests/example.ts', line: 2 },
      ]);
    }
    const escaped = 'opaque"value\\92837';
    expect(scanForInjectedSecrets(diff(JSON.stringify(escaped).slice(1, -1)), [escaped])).toHaveLength(1);
    expect(scanForInjectedSecrets(diff('safe'), ['', 'short', credential])).toEqual([]);
  });

  it('scans added content resembling a file header and ignores no-newline markers', () => {
    expect(scanForInjectedSecrets(diff(`++ ${credential}`), [credential])).toHaveLength(1);
    const outgoing = diff('safe').replace('+safe\n+tail', `+safe\n\\ No newline at end of file\n+${credential}`);
    expect(scanForInjectedSecrets(outgoing, [credential])).toEqual([{ file: 'tests/example.ts', line: 3 }]);
    expect(scanForInjectedSecrets(diff('safe').replace('-old', `-${credential}`), [credential])).toEqual([]);
  });

  it('extracts Codex credentials from pretty-printed auth.json and deduplicates env values', () => {
    const values = injectedSecretValues({
      CODEX_AUTH_JSON: JSON.stringify({ tokens: { access_token: credential, refresh_token: 'refresh-92837' } }, null, 2),
      OPENAI_API_KEY: credential,
      GH_TOKEN: 'short',
    });
    expect(values.filter((v) => v === credential)).toHaveLength(1);
    expect(values).toContain('refresh-92837');
    expect(scanForInjectedSecrets(diff(credential), values)).toHaveLength(1);
    expect(injectedSecretValues({ CODEX_AUTH_JSON: 'invalid-json' })).toEqual(['invalid-json']);
  });

  it('withholds injected credentials in pattern excerpts, filenames, comments and logs', () => {
    vi.stubEnv('OPENAI_API_KEY', credential);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const block = scanOutgoingForSecrets(diff(`Bearer abc123 ${credential}`, `${credential}.txt`), 'review');
    expect(block?.reason).toBe('findings');
    expect(JSON.stringify(block)).not.toContain(credential);
    expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
    expect(renderSecretBlockComment(block!)).not.toContain(credential);
  });
});
