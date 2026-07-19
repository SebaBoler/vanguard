import { test, expect } from 'vitest';
import { parseFlowHcl } from './parse.js';

const FLOW_B = `flow "flow-b" {
  label = "Plan → implement → adversary → repair"
  stage {
    name            = "planner"
    model           = "opus"
    effort          = "high"
    max_turns       = 10
    resume_previous = false
  }
  stage {
    name      = "implementer"
    model     = "sonnet"
    max_turns = 30
  }
}`;

test('parses a valid flow into a FlowDoc, preserving stage order', async () => {
  const doc = await parseFlowHcl(FLOW_B);
  expect(doc.name).toBe('flow-b');
  expect(doc.label).toMatch(/adversary/);
  expect(doc.stages.map((s) => s.name)).toEqual(['planner', 'implementer']);
  expect(doc.stages[0]?.overrides).toEqual({ model: 'opus', effort: 'high', maxTurns: 10, resumePrevious: false });
  expect(doc.stages[1]?.overrides).toEqual({ model: 'sonnet', maxTurns: 30 });
});

test('parses a ref stage', async () => {
  const doc = await parseFlowHcl('flow "f" {\n label = "l"\n stage {\n name = "x"\n ref = "scripts/c.ts#s"\n }\n}');
  expect(doc.stages[0]?.ref).toBe('scripts/c.ts#s');
});

test('rejects an unknown override key', async () => {
  await expect(parseFlowHcl('flow "f" {\n label = "l"\n stage {\n name = "planner"\n bogus = 1\n }\n}')).rejects.toThrow(/unknown key "bogus"/i);
});

test('rejects a stage with no name', async () => {
  await expect(parseFlowHcl('flow "f" {\n label = "l"\n stage {\n model = "opus"\n }\n}')).rejects.toThrow(/name/i);
});

test('rejects until = user_accept (interactive gate deferred)', async () => {
  await expect(
    parseFlowHcl('flow "f" {\n label = "l"\n loop {\n stages = ["a"]\n until = "user_accept"\n max = 3\n }\n}'),
  ).rejects.toThrow(/interactive gate/i);
});

test('parses a loop into a separate loops field', async () => {
  const doc = await parseFlowHcl('flow "f" {\n label = "l"\n loop {\n stages = ["planner", "review"]\n until = "reviewer_pass"\n max = 3\n }\n}');
  expect(doc.loops[0]).toEqual({ stages: ['planner', 'review'], until: 'reviewer_pass', max: 3 });
});

test('captures a meta block verbatim without interpreting it', async () => {
  const doc = await parseFlowHcl('flow "f" {\n label = "l"\n meta {\n x = "y"\n }\n stage {\n name = "planner"\n model = "opus"\n }\n}');
  expect(doc.meta).toEqual({ x: 'y' });
});

test('rejects a syntactically invalid flow', async () => {
  await expect(parseFlowHcl('flow "f" {')).rejects.toThrow();
});

test('rejects a file with no flow block', async () => {
  await expect(parseFlowHcl('resource "x" "y" {}')).rejects.toThrow(/exactly one flow/i);
});

test('rejects an unknown key at flow level', async () => {
  await expect(parseFlowHcl('flow "f" {\n label = "l"\n bogus = 1\n}')).rejects.toThrow(/unknown key "bogus" in flow/i);
});

test('rejects an unknown key at loop level', async () => {
  await expect(
    parseFlowHcl('flow "f" {\n label = "l"\n loop {\n stages = ["a"]\n until = "u"\n max = 2\n bogus = 1\n }\n}'),
  ).rejects.toThrow(/unknown key "bogus" in loop/i);
});

test('rejects two flow blocks sharing a label (drops none silently)', async () => {
  await expect(
    parseFlowHcl('flow "a" {\n label = "l"\n stage {\n name = "planner"\n }\n}\nflow "a" {\n label = "l"\n stage {\n name = "implementer"\n }\n}'),
  ).rejects.toThrow(/exactly one flow block named "a"/i);
});

test('rejects a label-less flow block with a clear message', async () => {
  await expect(parseFlowHcl('flow {\n label = "l"\n}')).rejects.toThrow(/missing its .*label/i);
});

test('rejects two meta blocks', async () => {
  await expect(parseFlowHcl('flow "f" {\n label = "l"\n meta {\n a = 1\n }\n meta {\n b = 2\n }\n}')).rejects.toThrow(
    /at most one meta/i,
  );
});

test('rejects a scalar meta', async () => {
  await expect(parseFlowHcl('flow "f" {\n label = "l"\n meta = "oops"\n}')).rejects.toThrow(/meta must be a block/i);
});
