import { execa } from 'execa';
import { VanguardError } from '../core/errors.js';
import { linearGraphql } from './linear-cli.js';
import type { LinearGraphql } from './linear-cli.js';

/** What a new task carries. `labels` are applied at creation; the transport decides what that means. */
export interface CreateTaskInput {
  title: string;
  body: string;
  labels?: string[];
}

/** A created task: the ref `vanguard run` accepts, and the URL to show the human. */
export interface CreatedTask {
  id: string;
  url: string;
}

/**
 * Body size ceiling.
 *
 * `glab` has no `--body-file`, so its description crosses as an argv value and is bounded by ARG_MAX
 * (~256KB on macOS, and that budget is shared with the environment). `gh` takes the body on stdin so it
 * has no such limit, and Linear takes it in a JSON body — but a single cap for all three keeps the rule
 * one thing a user can understand, and an issue body past this is not an issue body.
 *
 * Enforced BEFORE any request: hitting the real limit surfaces as a bare E2BIG from the OS, which tells
 * the user nothing.
 */
export const MAX_BODY_BYTES = 60_000;

/**
 * Title ceiling. The title crosses as an ARGV value on BOTH gh and glab, so an unbounded one hits
 * ARG_MAX exactly like an unbounded body would — surfacing a raw E2BIG on the irreversible path, which
 * is the failure the body cap exists to avoid. `titleFromDoc` returns a whole heading line, so a
 * pathological `# ...` is a doc away.
 */
export const MAX_TITLE_BYTES = 500;

/**
 * Runs `gh`/`glab` **in the repo directory**, optionally piping stdin.
 *
 * No `--repo`/`--project` flag: both CLIs infer the repository from the cwd's git remote (their
 * `--repo` flag exists to select *another* one). That is how the desktop board already shells them, and
 * it means neither transport needs a slug from config — which matters, because `AppConfig` has no
 * project field and there is no GitLab slug detector anywhere in core. Inferring is not a shortcut here;
 * it is the only option that works for both.
 */
export type CliRunner = (bin: 'gh' | 'glab', args: string[], opts: { cwd: string; stdin?: string }) => Promise<string>;

/**
 * Bound on the CLI itself, so a dead network fails instead of wedging the caller forever.
 *
 * The sidecar deliberately does NOT kill this exchange (see `Bound::Untimed`) — a kill mid-response
 * cannot un-create an issue. But with no bound anywhere, a hung `gh` holds the query pipe until the app
 * is restarted. So the bound lives HERE, at the transport, and is generous: a create that has not
 * returned in two minutes is not coming back. It carries the same ambiguity as any other failure — the
 * issue may already exist — which is exactly what the UI now tells the user, so nothing new is hidden.
 */
const CLI_TIMEOUT_MS = 120_000;

const defaultCli: CliRunner = async (bin, args, opts) =>
  (
    await execa(bin, args, {
      cwd: opts.cwd,
      timeout: CLI_TIMEOUT_MS,
      ...(opts.stdin === undefined ? {} : { input: opts.stdin }),
    })
  ).stdout;

function assertCreatable(input: CreateTaskInput): void {
  if (input.title.trim() === '') throw new VanguardError('A task needs a title.');
  const titleBytes = Buffer.byteLength(input.title, 'utf8');
  if (titleBytes > MAX_TITLE_BYTES) {
    throw new VanguardError(`Task title is ${titleBytes} bytes; the limit is ${MAX_TITLE_BYTES}. Shorten the heading.`);
  }
  const bytes = Buffer.byteLength(input.body, 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new VanguardError(`Task body is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}. Shorten the document.`);
  }
}

/**
 * The new issue's URL in some CLI output.
 *
 * Matches the ISSUE-shaped URL, not merely the first URL of any kind: `gh`/`glab` also emit project
 * links, progress lines and warnings. Taking the first URL blindly would make a SUCCESSFUL create look
 * like a failure ("returned a URL this does not understand") — and a reported failure invites the retry
 * that files the issue a second time. Reading the wrong line must never manufacture a duplicate.
 */
function issueUrl(stdout: string, what: string): string {
  const match = stdout.match(/https?:\/\/\S*\/issues\/\d+/);
  if (match === null) throw new VanguardError(`${what} did not print an issue URL: ${stdout.trim().slice(0, 200)}`);
  return match[0];
}

/** `https://github.com/o/r/issues/42` -> `o/r#42`; `https://gitlab.com/g/p/-/issues/7` -> `g/p#7`. */
function refFromIssueUrl(url: string, what: string): string {
  const m = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\/-)?\/issues\/(\d+)/);
  if (m?.[1] === undefined || m[2] === undefined) {
    throw new VanguardError(`${what} returned a URL this does not understand: ${url}`);
  }
  return `${m[1]}#${m[2]}`;
}

/**
 * Create a GitHub issue. The body goes over **stdin** (`--body-file -`), not argv: a doc-sized markdown
 * body on the command line is an ARG_MAX gamble, and `gh` gives us a clean way not to take it.
 */
export async function createGithubIssue(
  repoPath: string,
  input: CreateTaskInput,
  run: CliRunner = defaultCli,
): Promise<CreatedTask> {
  assertCreatable(input);
  const args = ['issue', 'create', '--title', input.title, '--body-file', '-'];
  for (const label of input.labels ?? []) args.push('--label', label);
  const url = issueUrl(await run('gh', args, { cwd: repoPath, stdin: input.body }), 'gh issue create');
  return { id: refFromIssueUrl(url, 'gh issue create'), url };
}

/**
 * Create a GitLab issue. `glab` has **no** `--body-file`, so the description crosses as an argv value —
 * safe from injection (execa passes an array, never a shell) but bounded by ARG_MAX, which is why
 * MAX_BODY_BYTES exists.
 */
export async function createGitlabIssue(
  repoPath: string,
  input: CreateTaskInput,
  run: CliRunner = defaultCli,
): Promise<CreatedTask> {
  assertCreatable(input);
  const args = ['issue', 'create', '--title', input.title, '--description', input.body];
  const labels = input.labels ?? [];
  if (labels.length > 0) args.push('--label', labels.join(','));
  const url = issueUrl(await run('glab', args, { cwd: repoPath }), 'glab issue create');
  return { id: refFromIssueUrl(url, 'glab issue create'), url };
}

const CREATE_MUTATION = `mutation($i: IssueCreateInput!) {
  issueCreate(input: $i) { success issue { identifier url } }
}`;
const TEAM_QUERY = `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`;

interface TeamResp {
  data?: { teams?: { nodes?: { id?: string }[] } };
}
interface CreateResp {
  data?: { issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } } };
  errors?: { message?: string }[];
}

/**
 * Create a Linear issue over **GraphQL**, not the CLI.
 *
 * `linear issue create` exists but has **no `--json`** — its output is human prose, so recovering the new
 * issue's identifier and URL would mean scraping it. That is the same mistake that left
 * `LinearCliTaskFetcher.list()` shelling a command which does not exist (see its note). The API returns
 * `{ identifier, url }` structurally, and does not change shape between CLI versions.
 */
export async function createLinearIssue(
  team: string,
  input: CreateTaskInput,
  graphql?: LinearGraphql,
): Promise<CreatedTask> {
  assertCreatable(input);
  const send = graphql ?? (await linearGraphql());

  // IssueCreateInput takes a teamId (a uuid), not the team key the user configures — so resolve it.
  const teams = (await send({ query: TEAM_QUERY, variables: { key: team } })) as TeamResp;
  const teamId = teams.data?.teams?.nodes?.[0]?.id;
  if (teamId === undefined) {
    throw new VanguardError(`No Linear team with key \`${team}\` — check the team key in Settings.`);
  }

  // NOTE: `input.labels` is ignored here. IssueCreateInput takes `labelIds` (uuids), not the names
  // GitHub/GitLab accept, so honouring them needs a name->id round-trip this does not do. The sidecar
  // does not pass labels for Linear at all, so nothing is silently dropped on the way in — but if you
  // ever pass them here, they will NOT be applied. Resolve them to ids first.
  const created = (await send({
    query: CREATE_MUTATION,
    variables: { i: { teamId, title: input.title, description: input.body } },
  })) as CreateResp;
  const errors = created.errors;
  if (errors !== undefined && errors.length > 0) {
    throw new VanguardError(`Linear API error: ${errors.map((e) => e.message ?? '').join('; ')}`);
  }
  const issue = created.data?.issueCreate?.issue;
  if (created.data?.issueCreate?.success !== true || issue?.identifier === undefined || issue.url === undefined) {
    // Never report success we cannot prove: the caller is about to tell a human "created", and this is
    // the one action in the app that cannot be undone from inside it.
    throw new VanguardError('Linear did not confirm the issue was created.');
  }
  return { id: issue.identifier, url: issue.url };
}
