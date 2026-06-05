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
      throw new SandboxError('Firecracker wymaga Linux/KVM (host Hetzner dedicated/AX)');
    }
    try {
      await access(KVM_DEVICE);
    } catch (cause) {
      throw new SandboxError(`Brak ${KVM_DEVICE} — Firecracker wymaga sprzętowego KVM`, { cause });
    }
    throw new NotImplementedError('Boot Firecracker — do implementacji na hoście KVM (faza infra)');
  }

  async exec(_command: string, _options?: ExecOptions): Promise<ExecResult> {
    throw new NotImplementedError('FirecrackerSandboxProvider.exec — faza infra');
  }

  execStream(_command: string, _options?: ExecOptions): ExecStream {
    throw new NotImplementedError('FirecrackerSandboxProvider.execStream — faza infra');
  }

  async copyIn(_hostPath: string, _sandboxPath: string): Promise<void> {
    throw new NotImplementedError('FirecrackerSandboxProvider.copyIn — faza infra');
  }

  async copyFileOut(_sandboxPath: string, _hostPath: string): Promise<void> {
    throw new NotImplementedError('FirecrackerSandboxProvider.copyFileOut — faza infra');
  }

  async exists(_sandboxPath: string): Promise<boolean> {
    throw new NotImplementedError('FirecrackerSandboxProvider.exists — faza infra');
  }

  async destroy(): Promise<void> {
    // No VM is booted yet, so teardown is a no-op until the boot path exists.
  }
}
