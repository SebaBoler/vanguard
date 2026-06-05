import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { NotImplementedError, SandboxError } from '../core/errors.js';
import type { ExecOptions, ExecResult, ExecStream, IsolatedSandboxProvider, SandboxConfig } from './provider.js';

const KVM_DEVICE = '/dev/kvm';

/**
 * Firecracker microVM sandbox. Target: Hetzner dedicated/AX (bare-metal KVM); Hetzner
 * Cloud lacks nested virtualisation. The boot path (kernel + rootfs + jailer + TAP
 * networking + SSH transport) is provisioned on the KVM host and lands in a later infra
 * phase. start() fails fast off Linux or without /dev/kvm so misuse is obvious.
 */
export class FirecrackerSandboxProvider implements IsolatedSandboxProvider {
  readonly id: string;
  private readonly config: SandboxConfig;

  constructor(config: SandboxConfig = {}) {
    this.config = config;
    this.id = `fc-${randomUUID()}`;
  }

  async start(): Promise<void> {
    if (process.platform !== 'linux') {
      throw new SandboxError('Firecracker requires Linux/KVM (Hetzner dedicated/AX host)');
    }
    try {
      await access(KVM_DEVICE);
    } catch (cause) {
      throw new SandboxError(`Missing ${KVM_DEVICE}: Firecracker requires hardware KVM`, { cause });
    }
    throw new NotImplementedError('Firecracker boot is not implemented yet (infra phase, KVM host)');
  }

  async exec(_command: string, _options?: ExecOptions): Promise<ExecResult> {
    throw new NotImplementedError('FirecrackerSandboxProvider.exec is not implemented yet (infra phase)');
  }

  execStream(_command: string, _options?: ExecOptions): ExecStream {
    throw new NotImplementedError('FirecrackerSandboxProvider.execStream is not implemented yet (infra phase)');
  }

  async copyIn(_hostPath: string, _sandboxPath: string): Promise<void> {
    throw new NotImplementedError('FirecrackerSandboxProvider.copyIn is not implemented yet (infra phase)');
  }

  async copyFileOut(_sandboxPath: string, _hostPath: string): Promise<void> {
    throw new NotImplementedError('FirecrackerSandboxProvider.copyFileOut is not implemented yet (infra phase)');
  }

  async exists(_sandboxPath: string): Promise<boolean> {
    throw new NotImplementedError('FirecrackerSandboxProvider.exists is not implemented yet (infra phase)');
  }

  async destroy(): Promise<void> {
    // No VM is booted yet, so teardown is a no-op until the boot path exists.
  }
}
