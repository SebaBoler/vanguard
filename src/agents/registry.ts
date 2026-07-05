import { ClaudeCodeProvider } from './claude-code.js';
import { CodexProvider } from './codex.js';
import { CursorProvider } from './cursor.js';
import { ZaiProvider, ZAI_BASE_URL } from './zai.js';
import { OpenRouterProvider, OPENROUTER_BASE_URL } from './openrouter.js';
import { MeridianProvider, MERIDIAN_PLACEHOLDER_TOKEN } from './meridian.js';
import { AgentError } from '../core/errors.js';
import type { AgentProvider } from './provider.js';

/**
 * Real provider keys handed to SECONDARY sidecars (proxy mode) — never injected into the sandbox.
 * Only providers proxied by their own sidecar appear here (Codex → OpenAI sidecar). Providers that ride
 * the PRIMARY sidecar (Zai) are NOT here: their key reaches the sidecar via `auth`, and proxy mode just
 * keeps it out of the sandbox (see providerSecrets + ownsAnthropicTransport).
 */
export interface ProviderProxySecrets {
  /** Real OpenAI/Codex key, owned by the OpenAI proxy sidecar instead of the sandbox. */
  codex?: string;
}

/**
 * The transport "slot" a provider drives inside the sandbox — the env namespace its CLI authenticates
 * through. Two DIFFERENT providers sharing one slot cannot run in the same sandbox: their env vars
 * collide (a sandbox env holds one ANTHROPIC_BASE_URL, one OPENAI_API_KEY, …). Claude and Zai both
 * drive the `claude` CLI via ANTHROPIC_*, so both occupy the 'anthropic' slot and cannot be paired.
 */
type Transport = 'anthropic' | 'openai' | 'cursor';

/** How a provider's API key is read from the host and wired into a run. Absent for auth-token providers (Claude). */
interface ProviderKeySpec {
  /** Host env var names to read the key from, in priority order. */
  hostEnv: string[];
  /** The sandbox env secrets the key becomes (the CLI reads these inside the sandbox, normal mode). */
  toSandboxSecrets: (key: string) => Record<string, string>;
  /** When set, in proxy mode the real key is held by a sidecar under this name instead of injected into the sandbox. */
  proxyKey?: keyof ProviderProxySecrets;
  /**
   * Optional credential-file env var that substitutes for the API key (subscription mode). When this host
   * env var is set, its value is forwarded verbatim into the sandbox under the same name and the API-key
   * requirement is waived — Codex on a ChatGPT subscription supplies its auth.json via CODEX_AUTH_JSON,
   * which CodexProvider writes to ~/.codex/auth.json. The credential lives in the sandbox like Claude's
   * CLAUDE_CODE_OAUTH_TOKEN, so --llm-proxy does not apply (Codex talks to OpenAI directly with it).
   */
  subscriptionEnv?: string;
  /**
   * Host→sandbox env passthrough applied in NORMAL mode only (never under --llm-proxy, whose sidecar
   * owns the upstream): when the host env var (the map key) is set, its value is forwarded verbatim into
   * the sandbox under the mapped name. Used to point Codex at a custom OpenAI-compatible endpoint via
   * OPENAI_BASE_URL → VANGUARD_OPENAI_BASE_URL (CodexProvider then writes a config.toml provider for it).
   */
  passthroughEnv?: Record<string, string>;
}

/** Everything the runner needs to know about one provider, in one place. */
interface ProviderSpec {
  /** Construct the provider's AgentProvider (each runs on its own default model). */
  factory: () => AgentProvider;
  /** Sandbox transport slot; distinct providers sharing a slot collide (see Transport). */
  transport: Transport;
  /** API-key wiring; absent when auth is handled by authSecrets instead (Claude). */
  key?: ProviderKeySpec;
  /**
   * When true, the provider owns the Anthropic transport with its OWN credentials, so the runner must
   * NOT also layer its Anthropic authSecrets (a competing ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
   * would make the Claude CLI prefer api.anthropic.com over this provider's endpoint).
   */
  ownsAnthropicTransport?: boolean;
  /**
   * When true, the provider cannot run under --llm-proxy: it owns the Anthropic transport but has no
   * upstream a trusted sidecar could target (it carries only a base URL and authenticates on its own
   * host, e.g. Meridian). Without this guard --llm-proxy would fall the sidecar back to api.anthropic.com.
   */
  directOnly?: boolean;
}

/**
 * Single source of truth for every selectable provider. Add a provider here and the CLI surface
 * (PROVIDER_NAMES/isProviderName), construction (makeProvider), the API-key requirement (requiresApiKey),
 * secret routing (providerSecrets), the transport-collision check, and Anthropic-auth suppression all
 * follow from this table — no per-site `if (name === …)` branches.
 *
 * Notes:
 * - Claude has no `key`: it authenticates via authSecrets (subscription token or ANTHROPIC_API_KEY).
 * - Codex authenticates with OPENAI_API_KEY (read from the documented CODEX_API_KEY, or OPENAI_API_KEY).
 * - Zai reuses the Claude CLI against z.ai's Anthropic-compatible endpoint, so it owns the 'anthropic'
 *   transport: in normal mode its key becomes ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN; in proxy mode
 *   the key is delivered to the primary sidecar via `auth` and withheld from the sandbox (not a secondary
 *   sidecar secret — see ownsAnthropicTransport in providerSecrets).
 * - OpenRouter is the same pattern as Zai, against OpenRouter's Anthropic-Messages-compatible "skin"
 *   instead of z.ai's endpoint: it also owns the 'anthropic' transport and rides the primary sidecar.
 */
const PROVIDERS = {
  claude: {
    factory: () => new ClaudeCodeProvider(),
    transport: 'anthropic',
  },
  codex: {
    factory: () => new CodexProvider(),
    transport: 'openai',
    key: {
      hostEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
      toSandboxSecrets: (key) => ({ OPENAI_API_KEY: key }),
      proxyKey: 'codex',
      // Run Codex on a ChatGPT subscription instead of an API key: CODEX_AUTH_JSON carries auth.json content.
      subscriptionEnv: 'CODEX_AUTH_JSON',
      // Set OPENAI_BASE_URL to run Codex against any OpenAI-compatible endpoint (Responses API) — direct mode only.
      passthroughEnv: { OPENAI_BASE_URL: 'VANGUARD_OPENAI_BASE_URL' },
    },
  },
  cursor: {
    factory: () => new CursorProvider(),
    transport: 'cursor',
    key: {
      hostEnv: ['CURSOR_API_KEY'],
      toSandboxSecrets: (key) => ({ CURSOR_API_KEY: key }),
    },
  },
  zai: {
    factory: () => new ZaiProvider(),
    transport: 'anthropic',
    ownsAnthropicTransport: true,
    key: {
      hostEnv: ['ZAI_API_KEY'],
      toSandboxSecrets: (key) => ({ ANTHROPIC_BASE_URL: ZAI_BASE_URL, ANTHROPIC_AUTH_TOKEN: key }),
      // No proxyKey: zai rides the PRIMARY sidecar (key delivered via auth). In proxy mode its key is
      // simply withheld from the sandbox via ownsAnthropicTransport — not handed to a secondary sidecar.
    },
  },
  openrouter: {
    factory: () => new OpenRouterProvider(),
    transport: 'anthropic',
    ownsAnthropicTransport: true,
    key: {
      hostEnv: ['OPENROUTER_API_KEY'],
      toSandboxSecrets: (key) => ({ ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL, ANTHROPIC_AUTH_TOKEN: key }),
      // No proxyKey: openrouter rides the PRIMARY sidecar, same as zai — see notes above.
    },
  },
  meridian: {
    factory: () => new MeridianProvider(),
    transport: 'anthropic',
    ownsAnthropicTransport: true,
    key: {
      // Meridian's base URL is operator-specific (its NAS/host address), so the "key" IS the base URL:
      // it flows through the same api-key slot but expands to ANTHROPIC_BASE_URL + a placeholder token
      // (Meridian authenticates on its own host and ignores the token — see meridian.ts).
      hostEnv: ['MERIDIAN_BASE_URL'],
      toSandboxSecrets: (url) => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: MERIDIAN_PLACEHOLDER_TOKEN }),
      // No proxyKey: meridian is direct-mode only (no upstream credential to hand a sidecar) — see meridian.ts.
    },
    directOnly: true,
  },
} satisfies Record<string, ProviderSpec>;

/** The providers selectable on the CLI. Selection is by provider, not by model. Order = table order. */
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];
export type ProviderName = keyof typeof PROVIDERS;

/** Typed view of a provider's spec (widens the table's narrow per-key types so optional fields are visible). */
const spec = (name: ProviderName): ProviderSpec => PROVIDERS[name];

/** Narrow an arbitrary string to a known provider name. */
export function isProviderName(value: string): value is ProviderName {
  return Object.hasOwn(PROVIDERS, value);
}

/** Construct an AgentProvider by name (each runs on its own default model). */
export function makeProvider(name: ProviderName): AgentProvider {
  return spec(name).factory();
}

/** Options controlling how provider secrets are routed. */
export interface ProviderSecretOptions {
  /** When true (--llm-proxy active), keys for proxyable providers are held back from the sandbox. */
  proxyMode?: boolean;
}

/** Returns true if the named provider requires an explicit API key (i.e. is not auth-token Claude). */
export function requiresApiKey(name: ProviderName): boolean {
  return spec(name).key !== undefined;
}

/**
 * Host env var(s) an Anthropic-transport-owning provider (zai, openrouter) reads its key from, in
 * priority order; undefined for providers that don't own the transport (they use Anthropic authSecrets
 * instead). Lets callers like agentAuthFromEnv resolve a primary-sidecar credential generically instead
 * of hardcoding a per-provider branch.
 */
export function anthropicTransportKeyEnv(name: ProviderName): string[] | undefined {
  const s = spec(name);
  return s.ownsAnthropicTransport === true ? s.key?.hostEnv : undefined;
}

/**
 * Collect the API-key secrets for the given providers, read from env and split into two buckets:
 * `sandboxSecrets` (the env vars the providers' CLIs read inside the sandbox) and `proxySecrets` (real
 * keys held by trusted sidecars, never injected into the sandbox). Throws if a selected provider's key
 * is missing — required whether it goes to the sandbox or a sidecar — so a run fails fast at dispatch
 * rather than mid-pipeline. Claude contributes nothing here (covered by authSecrets).
 *
 * Routing, driven entirely by each provider's PROVIDERS spec:
 * - Normal mode: the key is expanded via `toSandboxSecrets` into the sandbox.
 * - Proxy mode + `ownsAnthropicTransport` (Zai): emit nothing — the key reaches the PRIMARY sidecar via
 *   `auth`, and proxy mode just withholds it from the sandbox.
 * - Proxy mode + `proxyKey` (Codex): the key is routed to `proxySecrets[proxyKey]` for its own SECONDARY
 *   sidecar and kept out of `sandboxSecrets`.
 *
 * Invariant: in proxy mode a provider's real key never lands in `sandboxSecrets` — e.g. proxy-mode Codex
 * keeps `OPENAI_API_KEY` out (→ `proxySecrets.codex`) and proxy-mode Zai withholds its z.ai key entirely.
 */
export function providerSecrets(
  names: Iterable<ProviderName>,
  env: NodeJS.ProcessEnv = process.env,
  opts: ProviderSecretOptions = {},
): { sandboxSecrets: Record<string, string>; proxySecrets: ProviderProxySecrets } {
  const sandboxSecrets: Record<string, string> = {};
  const proxySecrets: ProviderProxySecrets = {};
  const seen = new Set<ProviderName>();
  for (const name of names) {
    if (seen.has(name)) continue; // dedupe (e.g. same provider for both stages)
    seen.add(name);

    const s = spec(name);
    const { key } = s;
    if (key === undefined) continue; // Claude: auth handled by authSecrets, no key to route here.

    // Subscription mode: a credential FILE substitutes for the API key. When its env var is set we
    // forward it into the sandbox under the same name and waive the API-key requirement — the credential
    // lives in the sandbox like Claude's OAuth token, so proxy mode does not apply. auth.json is usually
    // stored pretty-printed, so collapse it to single-line JSON: the sandbox secret layer rejects any
    // value with a newline. Forward as-is if it is not parseable JSON (the newline guard then catches
    // genuinely malformed input with a clear error).
    if (key.subscriptionEnv !== undefined) {
      const sub = env[key.subscriptionEnv];
      if (sub !== undefined && sub !== '') {
        let value = sub;
        try {
          const parsed: unknown = JSON.parse(sub);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new AgentError(`${key.subscriptionEnv} must be a JSON object (the contents of ~/.codex/auth.json).`);
          }
          value = JSON.stringify(parsed);
        } catch (e) {
          if (e instanceof AgentError) throw e; // a bare scalar/array parsed but is not auth.json — fail at dispatch
          /* not JSON — leave as-is; the sandbox newline guard / codex surfaces it */
        }
        sandboxSecrets[key.subscriptionEnv] = value;
        continue;
      }
    }

    const value = key.hostEnv.map((k) => env[k]).find((v) => v !== undefined && v !== '');
    if (value === undefined) {
      throw new AgentError(`Provider "${name}" needs ${key.hostEnv.join(' or ')} in the environment.`);
    }
    if (opts.proxyMode === true && s.ownsAnthropicTransport === true) {
      continue; // primary-sidecar provider (zai): key comes via auth; just withhold it from the sandbox.
    }
    if (opts.proxyMode === true && key.proxyKey !== undefined) {
      proxySecrets[key.proxyKey] = value;
    } else {
      Object.assign(sandboxSecrets, key.toSandboxSecrets(value));
      // Normal mode only: forward optional host env (e.g. a custom OpenAI base URL) into the sandbox.
      for (const [hostVar, sandboxVar] of Object.entries(key.passthroughEnv ?? {})) {
        const v = env[hostVar];
        if (v !== undefined && v !== '') sandboxSecrets[sandboxVar] = v;
      }
    }
  }
  return { sandboxSecrets, proxySecrets };
}

/** A run's provider choice: which provider implements, and optionally a different one for review. */
export interface ProviderChoice {
  /** Provider that implements (and, absent reviewProvider, runs every stage). Default 'claude'. */
  provider?: ProviderName;
  /** When set, run only the review stage on this provider (cross-provider review). */
  reviewProvider?: ProviderName;
}

/** True when the run needs an Anthropic-family credential (subscription token / API key). A used
 *  provider that owns the Anthropic transport with its own creds (zai) suppresses the need. */
export function needsAnthropicAuth(choice: ProviderChoice): boolean {
  const provider = choice.provider ?? 'claude';
  const used: ProviderName[] = [provider, ...(choice.reviewProvider !== undefined ? [choice.reviewProvider] : [])];
  return !used.some((n) => spec(n).ownsAnthropicTransport === true);
}

/** A resolved choice: the agents to run plus the secrets split into sandbox-safe and proxy-held buckets. */
export interface SelectedAgents {
  agent: AgentProvider;
  /** Present only when reviewProvider was set; pass to withStageProvider to route the review stage. */
  reviewAgent?: AgentProvider;
  /** Sandbox-safe secrets injected into the sandbox env. */
  secrets: Record<string, string>;
  /** Real provider keys held by trusted sidecars (proxy mode); never injected into the sandbox. */
  proxySecrets: ProviderProxySecrets;
  /**
   * Whether the runner should ALSO layer Anthropic authSecrets (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)
   * into the sandbox. False when any used provider owns the Anthropic transport with its own credentials
   * (Zai) — a stray Anthropic key would make the Claude CLI hit api.anthropic.com instead of that
   * provider's endpoint. True otherwise (Claude uses it; Codex/Cursor ignore it harmlessly).
   */
  injectAnthropicAuth: boolean;
}

/**
 * Throws when the provider/reviewProvider combination cannot run in one sandbox
 * (shared transport collision, or a reviewer-only primary-sidecar provider under --llm-proxy).
 */
export function validateProviderChoice(choice: ProviderChoice, opts: ProviderSecretOptions = {}): void {
  const provider = choice.provider ?? 'claude';
  const review = choice.reviewProvider;

  // Two distinct providers sharing one transport slot collide in a single sandbox (shared env namespace,
  // e.g. one ANTHROPIC_BASE_URL). Only the implement + review stages can differ, so a single pairwise
  // check suffices: claude+zai (both 'anthropic') is the case this rejects.
  if (review !== undefined && review !== provider && spec(review).transport === spec(provider).transport) {
    const names = [provider, review].sort().map((n) => `"${n}"`).join(' and ');
    throw new AgentError(
      `Cross-provider review cannot mix ${names}: they share the ${spec(provider).transport} transport and ` +
        `collide in one sandbox. Use the same provider for both stages, or pick providers on different transports.`,
    );
  }

  // A direct-only provider (meridian) has no upstream a sidecar could target, so --llm-proxy would
  // silently fall the sidecar back to api.anthropic.com. Reject the combination outright.
  if (opts.proxyMode === true) {
    const directOnly = [provider, ...(review !== undefined ? [review] : [])].find((n) => spec(n).directOnly === true);
    if (directOnly !== undefined) {
      throw new AgentError(
        `Provider "${directOnly}" is direct-mode only and cannot run under --llm-proxy: it authenticates ` +
          `on its own host and exposes no upstream for a trusted sidecar. Run it without --llm-proxy.`,
      );
    }
  }

  // Under --llm-proxy, a provider that owns the Anthropic transport (zai) is served by the PRIMARY sidecar,
  // whose upstream follows --provider only. So such a provider must BE the implementer; as a reviewer-only
  // it has no sidecar and would silently fall back to the implementer's Anthropic upstream + credential.
  if (opts.proxyMode === true && review !== undefined && review !== provider && spec(review).ownsAnthropicTransport === true) {
    throw new AgentError(
      `Cross-provider review with "${review}" under --llm-proxy needs "${review}" as the implementer too ` +
        `(--provider ${review}): it owns the primary sidecar, whose upstream follows --provider. ` +
        `Use --provider ${review}, or run this combination without --llm-proxy.`,
    );
  }
}

/**
 * Resolve a provider choice into agents + split secrets, shared by every runner. Keeps provider
 * construction, the used-provider set, the transport-collision check, the fail-fast key check, and
 * Anthropic-auth suppression in one place — all derived from the PROVIDERS table (no per-runner copy).
 */
export function selectAgents(
  choice: ProviderChoice,
  env: NodeJS.ProcessEnv = process.env,
  opts: ProviderSecretOptions = {},
): SelectedAgents {
  const provider = choice.provider ?? 'claude';
  const used: ProviderName[] = [provider, ...(choice.reviewProvider !== undefined ? [choice.reviewProvider] : [])];

  validateProviderChoice(choice, opts);

  const { sandboxSecrets, proxySecrets } = providerSecrets(used, env, opts);
  return {
    agent: makeProvider(provider),
    ...(choice.reviewProvider !== undefined ? { reviewAgent: makeProvider(choice.reviewProvider) } : {}),
    secrets: sandboxSecrets,
    proxySecrets,
    injectAnthropicAuth: !used.some((name) => spec(name).ownsAnthropicTransport === true),
  };
}
