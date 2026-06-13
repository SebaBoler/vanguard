import { describe, it, expect } from 'vitest';
import {
  assessTaskReadiness,
  hasRealAcceptanceCriteria,
  isVanguardSpec,
  stripHtmlComments,
  MIN_DESCRIPTION_CHARS,
  SPEC_TAG,
} from './triage.js';
import type { Task } from './fetcher.js';

/** Build a minimal Task fixture; only fields under test need to be supplied. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TES-1',
    title: 'Test task',
    description: '',
    labels: [],
    children: [],
    comments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// stripHtmlComments
// ---------------------------------------------------------------------------

describe('stripHtmlComments', () => {
  it('removes a simple inline HTML comment', () => {
    expect(stripHtmlComments('hello <!-- hidden --> world')).toBe('hello  world');
  });

  it('removes a multi-line HTML comment', () => {
    const input = 'before\n<!-- line1\nline2 -->\nafter';
    expect(stripHtmlComments(input)).toBe('before\n\nafter');
  });

  it('returns the string unchanged when there are no comments', () => {
    expect(stripHtmlComments('no comments here')).toBe('no comments here');
  });

  it('removes multiple HTML comments', () => {
    expect(stripHtmlComments('<!-- A -->text<!-- B -->')).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// hasRealAcceptanceCriteria
// ---------------------------------------------------------------------------

describe('hasRealAcceptanceCriteria', () => {
  it('returns false when no AC heading is present', () => {
    expect(hasRealAcceptanceCriteria('Some description without criteria.')).toBe(false);
  });

  it('returns false when AC heading is present but body is empty', () => {
    const text = '## Acceptance Criteria\n';
    expect(hasRealAcceptanceCriteria(text)).toBe(false);
  });

  it('returns false when all bullets are placeholder examples', () => {
    const text = [
      '## ✅ Acceptance Criteria',
      '- [ ] Feature X functions as intended.',
      '- [ ] Unit tests are written or updated to cover the new changes.',
      '- [ ] The existing CI pipeline passes successfully.',
    ].join('\n');
    expect(hasRealAcceptanceCriteria(text)).toBe(false);
  });

  it('returns true when at least one bullet is not a placeholder', () => {
    const text = [
      '## ✅ Acceptance Criteria',
      '- [ ] Feature X functions as intended.',
      '- [ ] The widget renders correctly on mobile devices.',
    ].join('\n');
    expect(hasRealAcceptanceCriteria(text)).toBe(true);
  });

  it('matches the heading case-insensitively', () => {
    const text = '## acceptance criteria\n- [ ] Custom criterion here.';
    expect(hasRealAcceptanceCriteria(text)).toBe(true);
  });

  it('stops scanning at the next heading', () => {
    const text = [
      '## Acceptance Criteria',
      '- [ ] Feature X functions as intended.',
      '## Notes',
      '- [ ] Real criterion that appears after Notes heading.',
    ].join('\n');
    // Only placeholder bullets before the next heading → false.
    expect(hasRealAcceptanceCriteria(text)).toBe(false);
  });

  it('handles `- [x]` (checked) bullets as real when not a placeholder', () => {
    const text = '## Acceptance Criteria\n- [x] Pagination works correctly.';
    expect(hasRealAcceptanceCriteria(text)).toBe(true);
  });

  it('handles `*` style bullets', () => {
    const text = '## Acceptance Criteria\n* Custom acceptance item.';
    expect(hasRealAcceptanceCriteria(text)).toBe(true);
  });

  it('detects criteria when the AC section uses CRLF line endings', () => {
    const text = '## Acceptance Criteria\r\n- [ ] The widget renders on mobile.\r\n';
    expect(hasRealAcceptanceCriteria(text)).toBe(true);
  });

  it('treats a lowercased placeholder line as a placeholder (case-insensitive)', () => {
    const text = '## Acceptance Criteria\n- [ ] feature x functions as intended.';
    expect(hasRealAcceptanceCriteria(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SPEC_TAG
// ---------------------------------------------------------------------------

describe('SPEC_TAG', () => {
  it('equals tech_spec (the XML tag name used by Vanguard)', () => {
    expect(SPEC_TAG).toBe('tech_spec');
  });
});

// ---------------------------------------------------------------------------
// isVanguardSpec (strict — only <tech_spec marker, not AC heading)
// ---------------------------------------------------------------------------

describe('isVanguardSpec', () => {
  it('returns true for a comment containing the <tech_spec opening tag', () => {
    expect(isVanguardSpec({ author: 'vanguard', body: `<${SPEC_TAG}>\ncontent\n</${SPEC_TAG}>` })).toBe(true);
  });

  it('returns false for a comment with only an Acceptance Criteria heading (no <tech_spec tag)', () => {
    expect(isVanguardSpec({ author: 'human', body: '## Acceptance Criteria\n- [ ] Something.' })).toBe(false);
  });

  it('returns false for an ordinary comment', () => {
    expect(isVanguardSpec({ author: 'alice', body: 'LGTM' })).toBe(false);
  });

  it('returns false for an empty body', () => {
    expect(isVanguardSpec({ author: 'alice', body: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assessTaskReadiness
// ---------------------------------------------------------------------------

describe('assessTaskReadiness', () => {
  // --- empty / whitespace description ---

  it('returns needs_info for an empty description (spec mode)', () => {
    expect(assessTaskReadiness(makeTask({ description: '' }), 'spec')).toBe('needs_info');
  });

  it('returns needs_info for a whitespace-only description (agent mode)', () => {
    expect(assessTaskReadiness(makeTask({ description: '   \n  ' }), 'agent')).toBe('needs_info');
  });

  it('returns needs_info for a description that is only HTML comments (agent mode)', () => {
    const description = '<!-- placeholder text that seems long enough but is actually empty -->';
    expect(assessTaskReadiness(makeTask({ description }), 'agent')).toBe('needs_info');
  });

  // --- short description ---

  it('returns needs_info when cleaned description is below MIN_DESCRIPTION_CHARS (spec mode)', () => {
    const short = 'Too short.'; // 10 chars < 30
    expect(assessTaskReadiness(makeTask({ description: short }), 'spec')).toBe('needs_info');
  });

  it(`considers one char below the threshold (${MIN_DESCRIPTION_CHARS - 1}) as needs_info (boundary, spec mode)`, () => {
    const boundary = 'x'.repeat(MIN_DESCRIPTION_CHARS - 1);
    expect(assessTaskReadiness(makeTask({ description: boundary }), 'spec')).toBe('needs_info');
  });

  // --- spec mode: real description is sufficient ---

  it('returns ok in spec mode when description is long enough, even without criteria', () => {
    const description = 'This describes the feature in enough detail to proceed.';
    expect(assessTaskReadiness(makeTask({ description }), 'spec')).toBe('ok');
  });

  // --- agent mode: needs criteria or spec comment ---

  it('returns needs_info in agent mode with a real description but no criteria and no spec comment', () => {
    const description = 'This describes the feature in enough detail to proceed.';
    expect(assessTaskReadiness(makeTask({ description }), 'agent')).toBe('needs_info');
  });

  it('returns needs_info in agent mode when AC header is present but only placeholder bullets', () => {
    const description = [
      'This task describes a feature in enough detail for the description gate.',
      '',
      '## ✅ Acceptance Criteria',
      '- [ ] Feature X functions as intended.',
      '- [ ] The existing CI pipeline passes successfully.',
    ].join('\n');
    expect(assessTaskReadiness(makeTask({ description }), 'agent')).toBe('needs_info');
  });

  it('returns ok in agent mode when AC header is present with real bullets', () => {
    const description = [
      'This task describes a feature in enough detail for the description gate.',
      '',
      '## ✅ Acceptance Criteria',
      '- [ ] The dashboard renders the new chart component.',
      '- [ ] Clicking a bar navigates to the detail view.',
    ].join('\n');
    expect(assessTaskReadiness(makeTask({ description }), 'agent')).toBe('ok');
  });

  it('returns needs_info in agent mode when AC heading is present but the body is empty', () => {
    const description = [
      'This task describes a feature in enough detail for the description gate.',
      '',
      '## Acceptance Criteria',
    ].join('\n');
    expect(assessTaskReadiness(makeTask({ description }), 'agent')).toBe('needs_info');
  });

  it('returns ok in agent mode when no criteria but a spec comment (tech_spec marker) is present', () => {
    const description = 'This task describes a feature in enough detail for the description gate.';
    const comments = [{ author: 'vanguard-bot', body: '<tech_spec>\n## Overview\nDo the thing.\n</tech_spec>' }];
    expect(assessTaskReadiness(makeTask({ description, comments }), 'agent')).toBe('ok');
  });

  it('returns ok in agent mode when no criteria but a spec comment (Acceptance heading) is present', () => {
    const description = 'This task describes a feature in enough detail for the description gate.';
    const comments = [{ author: 'vanguard-bot', body: '## Acceptance Criteria\n- [ ] Something real.' }];
    expect(assessTaskReadiness(makeTask({ description, comments }), 'agent')).toBe('ok');
  });

  it('ignores empty comments when checking for spec comment', () => {
    const description = 'This task describes a feature in enough detail for the description gate.';
    const comments = [{ author: 'alice', body: '' }];
    expect(assessTaskReadiness(makeTask({ description, comments }), 'agent')).toBe('needs_info');
  });

  it('returns needs_info in agent mode when a comment has only an "Acceptance Criteria" heading with no real bullets', () => {
    const description = 'This task describes a feature in enough detail for the description gate.';
    const comments = [{ author: 'pm', body: '## Acceptance Criteria' }];
    expect(assessTaskReadiness(makeTask({ description, comments }), 'agent')).toBe('needs_info');
  });

  it('returns ok in agent mode when a comment has an Acceptance Criteria heading with real bullets', () => {
    const description = 'This task describes a feature in enough detail for the description gate.';
    const comments = [{ author: 'pm', body: '## Acceptance Criteria\n- [ ] The export button generates a valid CSV file.' }];
    expect(assessTaskReadiness(makeTask({ description, comments }), 'agent')).toBe('ok');
  });

  it('returns ok in agent mode when a comment contains a <tech_spec> marker', () => {
    const description = 'This task describes a feature in enough detail for the description gate.';
    const comments = [{ author: 'vanguard-bot', body: '<tech_spec>\n## Architecture\nUse event sourcing.\n</tech_spec>' }];
    expect(assessTaskReadiness(makeTask({ description, comments }), 'agent')).toBe('ok');
  });
});
