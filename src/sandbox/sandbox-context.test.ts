import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EGRESS_ALLOWLIST } from './egress-allow.mjs';
import { llmProxyEgressAllowlist } from './egress-proxy.js';

const startEgressEnclave = vi.fn(async (_opts?: { allowlist?: readonly string[] }) => ({
  proxyUrl: 'http://vg-proxy:3128',
  network: 'vg-egr-test',
  destroy: async (): Promise<void> => {},
}));
vi.mock('./egress-network.js', () => ({
  startEgressEnclave: (opts?: { allowlist?: readonly string[] }): Promise<unknown> => startEgressEnclave(opts),
}));
vi.mock('./llm-proxy.js', () => ({
  startLlmProxy: vi.fn(async () => ({ url: 'http://vg-llm:8088', nonce: 'n', host: 'vg-llm', destroy: async (): Promise<void> => {} })),
}));

const { startSandboxContext } = await import('./sandbox-context.js');

describe('startSandboxContext extraEgressHosts (S6)', () => {
  beforeEach(() => startEgressEnclave.mockClear());

  it('plain --egress with no extras keeps the default allowlist (no opts — enclave defaults apply)', async () => {
    await startSandboxContext({ egress: true, llmProxy: false });
    expect(startEgressEnclave).toHaveBeenCalledWith({});
  });

  it('plain --egress + extras materializes DEFAULT_EGRESS_ALLOWLIST + the custom hosts', async () => {
    await startSandboxContext({ egress: true, llmProxy: false, extraEgressHosts: ['llm.example.com'] });
    expect(startEgressEnclave).toHaveBeenCalledWith({
      allowlist: [...DEFAULT_EGRESS_ALLOWLIST, 'llm.example.com'],
    });
  });

  it('llm-proxy mode appends extras to the sidecar-stripped allowlist', async () => {
    await startSandboxContext({
      egress: true,
      llmProxy: true,
      auth: { mode: 'subscription', token: 't' },
      extraEgressHosts: ['llm.example.com'],
    });
    expect(startEgressEnclave).toHaveBeenCalledWith({
      allowlist: [...llmProxyEgressAllowlist(), 'llm.example.com'],
    });
  });

  it('neither flag: no enclave at all', async () => {
    await startSandboxContext({ egress: false, llmProxy: false, extraEgressHosts: ['llm.example.com'] });
    expect(startEgressEnclave).not.toHaveBeenCalled();
  });
});
