import { expect, test } from 'vitest';
import { parseAgentStream } from './parseStream';

test('blank lines and non-JSON garbage are skipped', () => {
  expect(parseAgentStream('\n  \nnot json\n{bad')).toEqual([]);
});

test('assistant text and tool_use are extracted; empty text is dropped', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Working on it' },
        { type: 'text', text: '   ' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts' } },
      ],
    },
  });
  expect(parseAgentStream(raw)).toEqual([
    { role: 'assistant', text: 'Working on it' },
    { role: 'tool', text: 'Edit · /a/b.ts' },
  ]);
});

test('tool_use with no hintable input shows just the name', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Glob', input: {} }] },
  });
  expect(parseAgentStream(raw)).toEqual([{ role: 'tool', text: 'Glob' }]);
});

test('tool_result content is coalesced from an array of blocks', () => {
  const raw = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ text: 'line one' }, 'line two'] }] },
  });
  expect(parseAgentStream(raw)).toEqual([{ role: 'tool_result', text: 'line one line two' }]);
});

test('empty tool_result is dropped', () => {
  const raw = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: '' }] },
  });
  expect(parseAgentStream(raw)).toEqual([]);
});

test('result line formats subtype and cost as $x.xx', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.1 });
  expect(parseAgentStream(raw)).toEqual([{ role: 'result', text: 'success · $0.10' }]);
});

test('result with no cost omits the price suffix', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'error_max_turns' });
  expect(parseAgentStream(raw)).toEqual([{ role: 'result', text: 'error_max_turns' }]);
});

test('a multi-line transcript preserves order across message types', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    'garbage that should be skipped',
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1.5 }),
  ].join('\n');
  expect(parseAgentStream(raw)).toEqual([
    { role: 'assistant', text: 'hi' },
    { role: 'result', text: 'success · $1.50' },
  ]);
});
