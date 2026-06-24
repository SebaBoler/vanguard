import { defaultGhRunner, commentGithubIssue, editGithubLabels, GitHubTaskFetcher } from '../tasks/github.js';
import { GITHUB_NEEDS_RESEARCH_LABEL, GITHUB_RESEARCHING_LABEL } from '../github-labels.js';
import type { GhRunner } from '../tasks/github.js';
import type { Task, TaskComment } from '../tasks/fetcher.js';
const PROMISE_RE = /<promise>\s*COMPLETE\s*<\/promise>/gi;
const RESEARCH_MARKER = 'vanguard-research';

export type Researcher = (prompt: string) => Promise<string>;

export interface ResearchDeps {
  repoSlug: string;
  researcher: Researcher;
  webAccess?: boolean;
  gh?: GhRunner;
  log?: (line: string) => void;
}

export interface ResearchResult {
  task: Task;
  commentBody: string;
  iteration: number;
}

export function isResearchComment(comment: TaskComment): boolean {
  return comment.body.includes(`<!-- ${RESEARCH_MARKER}:`);
}

export function priorResearchFindings(task: Task): string[] {
  return task.comments.filter(isResearchComment).map((c) => c.body);
}

/**
 * Builds the external-research prompt. Pure — unit-tested.
 * Embeds prior findings (if any) under a <prior_research> block with "extend, don't repeat" instructions.
 */
export function buildResearchPrompt(
  task: Task,
  opts: { priorFindings: string[]; webAccess: boolean },
): string {
  const { priorFindings, webAccess } = opts;

  const webInstruction = webAccess
    ? 'You have web search and fetch tools available. Use them to find relevant prior art, standards, library documentation, and real-world examples. Cite your sources with URLs.'
    : [
        'Web access is NOT available in this sandbox. Conduct model-knowledge research only.',
        'Draw on your training knowledge of relevant standards, libraries, frameworks, and prior art.',
        'Do NOT fabricate URLs, citations, or version numbers you are not certain about.',
        'Clearly mark any claim you are uncertain about with "Note: unverified".',
      ].join(' ');

  const priorBlock =
    priorFindings.length > 0
      ? [
          '<prior_research>',
          ...priorFindings,
          '</prior_research>',
          '',
          'The prior research above has already been posted to the issue. Do not repeat what is already covered.',
          'EXTEND, REFINE, and FILL GAPS in the prior findings. Build on the existing research rather than restating it.',
          '',
        ].join('\n')
      : '';

  const desc = task.description.trim();
  return [
    '<task_instructions>',
    `Issue: ${task.id}`,
    `Title: ${task.title}`,
    '',
    'Description:',
    desc === '' ? '(empty)' : desc,
    '',
    ...(priorBlock !== '' ? [priorBlock] : []),
    'RESEARCH GOAL: Gather EXTERNAL context for this issue — prior art, relevant standards,',
    'library/API documentation, known patterns, reference implementations, and open questions.',
    'This is NOT codebase research. Focus on external knowledge that will inform the eventual',
    'technical spec and implementation.',
    '',
    webInstruction,
    '',
    'Your findings report must include:',
    '- **Prior Art & Related Work** — existing tools, libraries, RFCs, or patterns that apply',
    '- **Relevant Standards / Specifications** — specs, RFCs, official docs this work must conform to',
    '- **Key Technical Considerations** — design decisions, trade-offs, known pitfalls',
    '- **Recommended Approach** — based on research, what approach best fits the stated goal',
    '- **Open Questions** — gaps in knowledge that require further investigation or human decision',
    '',
    'Return Markdown only. When done, write <promise>COMPLETE</promise>.',
    '</task_instructions>',
  ].join('\n');
}

/**
 * Strips the <promise> marker, prepends the heading + mode line, appends the hidden iteration marker.
 * Pure — unit-tested.
 * Empty agentText produces a sentinel ("No findings produced.") rather than an empty body.
 */
export function formatResearchComment(
  agentText: string,
  opts: { webAccess: boolean; iteration: number },
): string {
  const { webAccess, iteration } = opts;
  const body = agentText.replace(PROMISE_RE, '').trim();
  const modeLabel = webAccess ? 'web research' : 'model-knowledge only (no web egress)';
  const heading = `## Vanguard Research (iteration ${iteration})`;
  const modeLine = `_Mode: ${modeLabel}_`;
  const content = body === '' ? 'No findings produced.' : body;
  const marker = `<!-- ${RESEARCH_MARKER}: ${iteration} -->`;
  return `${heading}\n\n${modeLine}\n\n${content}\n\n${marker}`;
}

/**
 * Fetch issue, claim label, run external-research agent, post findings, declaim (REST — no advance).
 * On failure: revert label to needs-research and post an error comment (best-effort).
 * Comment is posted BEFORE declaiming so a crash between them leaves the issue claimed (retry-safe).
 */
export async function runResearch(issueRef: string, deps: ResearchDeps): Promise<ResearchResult> {
  const gh = deps.gh ?? defaultGhRunner;
  const log = deps.log ?? ((): void => undefined);
  const logR = (msg: string): void => log(`research ${issueRef}: ${msg}`);
  const webAccess = deps.webAccess ?? false;

  const fetcher = new GitHubTaskFetcher(deps.repoSlug, gh);

  logR('fetch');
  const task = await fetcher.fetch(issueRef);
  if (!task.labels.includes(GITHUB_NEEDS_RESEARCH_LABEL)) {
    throw new Error(`research ${issueRef}: issue must have the "${GITHUB_NEEDS_RESEARCH_LABEL}" label`);
  }

  // Claim: swap needs-research → vanguard:researching
  logR('claim');
  await editGithubLabels(deps.repoSlug, issueRef, { remove: [GITHUB_NEEDS_RESEARCH_LABEL], add: [GITHUB_RESEARCHING_LABEL] }, gh);

  const prior = priorResearchFindings(task);
  const iteration = prior.length + 1;

  try {
    logR(`building prompt (iteration ${iteration})`);
    const prompt = buildResearchPrompt(task, { priorFindings: prior, webAccess });

    logR('agent → researching');
    const agentText = await deps.researcher(prompt);

    const commentBody = formatResearchComment(agentText, { webAccess, iteration });

    // Post comment BEFORE declaiming — so a crash between the two leaves the issue claimed (retry-safe).
    logR('posting findings');
    await commentGithubIssue(deps.repoSlug, issueRef, commentBody, gh);

    // Declaim: remove vanguard:researching — REST (no routing label added, human drives next step).
    logR('declaim (resting)');
    await editGithubLabels(deps.repoSlug, issueRef, { remove: [GITHUB_RESEARCHING_LABEL] }, gh);

    logR(`done (iteration ${iteration})`);
    return { task, commentBody, iteration };
  } catch (err) {
    // Revert label and post error comment in parallel (best-effort) so the human can retry.
    logR('failure — reverting label');
    const errMsg = err instanceof Error ? err.message : String(err);
    await Promise.all([
      editGithubLabels(deps.repoSlug, issueRef, { remove: [GITHUB_RESEARCHING_LABEL], add: [GITHUB_NEEDS_RESEARCH_LABEL] }, gh).catch(() => undefined),
      commentGithubIssue(
        deps.repoSlug,
        issueRef,
        `## Vanguard Research — Error\n\nThe research run failed:\n\n\`\`\`\n${errMsg}\n\`\`\`\n\nRe-apply \`${GITHUB_NEEDS_RESEARCH_LABEL}\` to retry.`,
        gh,
      ).catch(() => undefined),
    ]);
    throw err;
  }
}
