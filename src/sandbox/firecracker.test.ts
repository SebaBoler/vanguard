import { describe, it, expect } from 'vitest';
import { FirecrackerSandboxProvider } from './firecracker.js';

describe('FirecrackerSandboxProvider', () => {
  it.skipIf(process.platform === 'linux')('refuses to start off Linux', async () => {
    const sb = new FirecrackerSandboxProvider({ image: 'rootfs.ext4' });
    await expect(sb.start()).rejects.toThrow(/Linux/);
  });
});
