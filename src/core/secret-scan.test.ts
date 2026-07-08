import { describe, it, expect } from 'vitest';
import { redactTokens, scanForSecrets } from './secret-scan.js';

const FAKE_JWT = 'eyJhbGciOiJSUzI1Ni19.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123';
const FAKE_SK_KEY = 'sk-FAKEtestkeyABCDEFGHIJ1234567890';

function diffOf(files: { path: string; lines: string[] }[]): string {
  return files
    .map(
      (f) =>
        [`diff --git a/${f.path} b/${f.path}`, `--- a/${f.path}`, `+++ b/${f.path}`, '@@ -1,1 +1,2 @@', ...f.lines].join(
          '\n',
        ),
    )
    .join('\n');
}

describe('redactTokens', () => {
  it('redacts JWTs, Bearer headers, and token JSON fields (unchanged from codex.ts)', () => {
    expect(redactTokens(`got ${FAKE_JWT} here`)).toBe('got [REDACTED-JWT] here');
    expect(redactTokens('Authorization: Bearer sk-abc.DEF_123-xyz')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactTokens('{"refresh_token":"rt_secret_value","x":1}')).toBe('{"refresh_token":"[REDACTED]","x":1}');
    expect(redactTokens('{"access_token": "at_secret"}')).toBe('{"access_token": "[REDACTED]"}');
  });

  it('leaves non-credential text untouched', () => {
    expect(redactTokens('account is not active')).toBe('account is not active');
  });

  it('redacts a bare fake sk- key and a key=value assignment (new patterns)', () => {
    expect(redactTokens(`OPENAI_API_KEY=${FAKE_SK_KEY}`)).toContain('[REDACTED');
    expect(redactTokens(`export ${FAKE_SK_KEY}`)).toBe(`export [REDACTED-KEY]`);
    expect(redactTokens('token=abcdef0123456789abcdef')).toBe('token=[REDACTED]');
  });
});

describe('scanForSecrets', () => {
  it('detects a seeded FAKE JWT on an added line', () => {
    const diff = diffOf([{ path: 'src/foo.ts', lines: [`+const token = "${FAKE_JWT}";`] }]);
    const findings = scanForSecrets(diff);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'src/foo.ts', patternName: 'jwt' }),
    );
  });

  it('does NOT flag a package-lock integrity hash that happens to contain "eyJ" (real JWTs have two dots, hashes have none)', () => {
    const diff = diffOf([
      {
        path: 'apps/backoffice/pnpm-lock.yaml',
        lines: ['+      integrity: sha512-eyJabcdEFGH1234567890ijklMNOPqrstUVWXyz0123456789abcdefABCDEFghijklmnopqrIJKLMNOPqRsTuVwXyZ+/w==}'],
      },
    ]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'jwt')).toBe(false);
  });

  it('detects a Bearer header on an added line', () => {
    const diff = diffOf([{ path: 'src/foo.ts', lines: ['+const h = "Authorization: Bearer sk-abc.DEF_123-xyz";'] }]);
    const findings = scanForSecrets(diff);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'src/foo.ts', patternName: 'bearer' }),
    );
  });

  it('detects a fake sk- key on an added line', () => {
    const diff = diffOf([{ path: 'src/foo.ts', lines: [`+const key = "${FAKE_SK_KEY}";`] }]);
    const findings = scanForSecrets(diff);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'src/foo.ts', patternName: 'openai-key' }),
    );
  });

  it('does NOT flag an assignment whose value is a code reference (request.cookies), not a literal secret', () => {
    const diff = diffOf([
      {
        path: 'apps/backoffice/src/lib/e2e-bypass.ts',
        lines: ['+  const cookieToken = request.cookies?.get(E2E_BYPASS_COOKIE);'],
      },
    ]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'assignment')).toBe(false);
  });

  it('never leaks the raw secret value in the serialised findings', () => {
    const diff = diffOf([
      { path: 'src/foo.ts', lines: [`+const jwt = "${FAKE_JWT}";`, `+const key = "${FAKE_SK_KEY}";`] },
    ]);
    const findings = scanForSecrets(diff);
    const serialised = JSON.stringify(findings);
    expect(serialised).not.toContain(FAKE_JWT);
    expect(serialised).not.toContain(FAKE_SK_KEY);
    expect(serialised).toMatch(/\[REDACTED/);
  });

  it('returns no findings for a clean diff of ordinary code', () => {
    const diff = diffOf([
      {
        path: 'src/util.ts',
        lines: [
          '+export function skip(n: number): number {',
          '+  const identifier = "user-42";',
          '+  return n + 1;',
          '+}',
        ],
      },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('only flags added lines, not context/removed lines or the +++ header', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      `+++ b/src/foo.ts`,
      '@@ -1,2 +1,2 @@',
      ` const x = 1;`,
      `-const jwt = "${FAKE_JWT}";`,
      '+const jwt = "replaced";',
    ].join('\n');
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('attributes findings to the correct file across multiple files', () => {
    const diff = diffOf([
      { path: 'src/a.ts', lines: [`+const jwt = "${FAKE_JWT}";`] },
      { path: 'src/b.ts', lines: [`+const key = "${FAKE_SK_KEY}";`] },
    ]);
    const findings = scanForSecrets(diff);
    expect(findings.find((f) => f.patternName === 'jwt')?.file).toBe('src/a.ts');
    expect(findings.find((f) => f.patternName === 'openai-key')?.file).toBe('src/b.ts');
  });

  it('skips test and fixture files (their fake secrets are not real leaks)', () => {
    const diff = diffOf([
      { path: 'src/core/secret-scan.test.ts', lines: [`+const jwt = "${FAKE_JWT}";`] },
      { path: 'src/cli/run-options.fixture.ts', lines: [`+const key = "${FAKE_SK_KEY}";`] },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips .spec.ts and .e2e-spec.ts files (NestJS/Jest/Vitest convention)', () => {
    const diff = diffOf([
      { path: 'apps/api/src/file/cloud-run-job.service.spec.ts', lines: [`+const CONFIGURED_CALLBACK_TOKEN = "${FAKE_SK_KEY}";`] },
      { path: 'apps/api/src/app.e2e-spec.ts', lines: [`+const jwt = "${FAKE_JWT}";`] },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('still flags the same secret in a non-test source file', () => {
    const diff = diffOf([{ path: 'src/config.ts', lines: [`+const jwt = "${FAKE_JWT}";`] }]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/config.ts', patternName: 'jwt' }),
    );
  });
});

describe('python test-path exclusion', () => {
  it('skips a test_*.py file (pytest prefix convention)', () => {
    const diff = diffOf([
      {
        path: 'apps/prefect_flows/tests/test_export_exceptions.py',
        lines: [`+    assert posted["headers"]["Authorization"] == "Bearer ${FAKE_JWT}"`],
      },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips a *_test.py file (pytest suffix convention)', () => {
    const diff = diffOf([{ path: 'apps/svc/foo_test.py', lines: [`+key = "${FAKE_SK_KEY}"`] }]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips conftest.py', () => {
    const diff = diffOf([{ path: 'apps/x/conftest.py', lines: [`+jwt = "${FAKE_JWT}"`] }]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips non-test helper modules under a tests/ directory (language-agnostic dir rule)', () => {
    const diff = diffOf([{ path: 'apps/x/tests/helpers.py', lines: [`+key = "${FAKE_SK_KEY}"`] }]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('still flags the same secret in a non-test .py source file', () => {
    const diff = diffOf([{ path: 'src/service.py', lines: [`+jwt = "${FAKE_JWT}"`] }]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/service.py', patternName: 'jwt' }),
    );
  });

  it('does NOT over-match files whose names merely contain "test"/"latest"', () => {
    const diff = diffOf([
      { path: 'contest.py', lines: [`+jwt = "${FAKE_JWT}"`] },
      { path: 'latest_data.py', lines: [`+key = "${FAKE_SK_KEY}"`] },
    ]);
    const findings = scanForSecrets(diff);
    expect(findings.some((f) => f.file === 'contest.py')).toBe(true);
    expect(findings.some((f) => f.file === 'latest_data.py')).toBe(true);
  });

  it('is case-insensitive for the new Python branches', () => {
    const diff = diffOf([
      { path: 'apps/x/TEST_FOO.PY', lines: [`+jwt = "${FAKE_JWT}"`] },
      { path: 'apps/x/Conftest.py', lines: [`+key = "${FAKE_SK_KEY}"`] },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });
});

describe('assignment refine: identifier chains', () => {
  it('does not flag a dotted code reference assigned to an auth-ish name', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,1 +1,2 @@',
      '+const auth = opts.pushToken ? pushAuthConfigArgs(opts.pushToken, opts.host) : [];',
      '+const token = deps.auth.accessToken;',
    ].join('\n');
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('still flags a realistic secret-like value on the same shape of line', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,1 +1,1 @@',
      '+const auth = "q7Rw2xZk9mP4vN8s";',
    ].join('\n');
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/x.ts', patternName: 'assignment' }),
    );
  });
});

describe('allowlist marker (global suppression)', () => {
  it.each([
    ['bearer', '+const h = "Authorization: Bearer sk-abc.DEF_123-xyz"', '// gitleaks:allow'],
    ['jwt', `+const token = "${FAKE_JWT}"`, '// pragma: allowlist secret'],
    ['openai-key', `+const key = "${FAKE_SK_KEY}"`, '// vanguard-allow-secret'],
    ['json-token-field', '+const payload = {"access_token":"rt_secret_value"}', '// gitleaks:allow'],
    ['assignment', '+const auth = "q7Rw2xZk9mP4vN8s"', '// gitleaks:allow'],
  ])('suppresses a %s finding when the marker is on the same line (control: flags without it)', (patternName, code, marker) => {
    const withMarker = diffOf([{ path: 'src/config.ts', lines: [`${code}; ${marker}`] }]);
    expect(scanForSecrets(withMarker).some((f) => f.patternName === patternName)).toBe(false);

    const withoutMarker = diffOf([{ path: 'src/config.ts', lines: [`${code};`] }]);
    expect(scanForSecrets(withoutMarker).some((f) => f.patternName === patternName)).toBe(true);
  });

  it('does not suppress a secret on the next added line (marker scope is per-line)', () => {
    const diff = diffOf([
      {
        path: 'src/config.ts',
        lines: ['+const note = "see docs"; // gitleaks:allow', `+const key = "${FAKE_SK_KEY}";`],
      },
    ]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/config.ts', patternName: 'openai-key' }),
    );
  });

  it('does not suppress a secret on a different added line even when the marker is standalone', () => {
    const diff = diffOf([
      { path: 'src/config.ts', lines: [`+const key = "${FAKE_SK_KEY}";`, '+// gitleaks:allow'] },
    ]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/config.ts', patternName: 'openai-key' }),
    );
  });

  it('is case-insensitive for the marker', () => {
    const diff = diffOf([
      { path: 'src/config.ts', lines: [`+const key = "${FAKE_SK_KEY}"; // GITLEAKS:ALLOW`] },
    ]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'openai-key')).toBe(false);

    const diff2 = diffOf([
      { path: 'src/config.ts', lines: [`+const token = "${FAKE_JWT}"; // Pragma: Allowlist Secret`] },
    ]);
    expect(scanForSecrets(diff2).some((f) => f.patternName === 'jwt')).toBe(false);
  });
});
