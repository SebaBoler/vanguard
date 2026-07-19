import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFlowResolvable,
  coerceFlowDoc,
  deleteRepoFlow,
  flowDocError,
  FlowError,
  listRepoFlows,
  readRepoFlow,
  resolveRepoFlow,
  unknownFlowError,
  writeRepoFlow,
} from './repo.js';
import type { FlowDoc } from './types.js';

let repo: string;
const flowsDir = (): string => join(repo, '.vanguard', 'flows');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-flows-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const HEALTHY = 'flow "my-flow" {\n  label = "Mine"\n\n  stage {\n    name = "implementer"\n    model = "sonnet"\n  }\n}\n';

async function seed(file: string, content: string): Promise<void> {
  await mkdir(flowsDir(), { recursive: true });
  await writeFile(join(flowsDir(), file), content, 'utf8');
}

describe('listRepoFlows', () => {
  it('returns [] for a repo with no flows dir', async () => {
    expect(await listRepoFlows(repo)).toEqual([]);
  });

  it('lists a healthy flow with name + label and no error', async () => {
    await seed('my-flow.hcl', HEALTHY);
    expect(await listRepoFlows(repo)).toEqual([{ file: 'my-flow.hcl', name: 'my-flow', label: 'Mine' }]);
  });

  it('surfaces a parse-broken file as an error entry with no name (not openable)', async () => {
    await seed('broken.hcl', 'flow "broken" { label = ');
    const [entry] = await listRepoFlows(repo);
    expect(entry?.file).toBe('broken.hcl');
    expect(entry?.name).toBeUndefined();
    expect(entry?.error).toBeTruthy();
  });

  it('surfaces a nonconforming filename as an error entry it would otherwise refuse to read back', async () => {
    await seed('My-Flow.hcl', HEALTHY);
    const [entry] = await listRepoFlows(repo);
    expect(entry).toMatchObject({ file: 'My-Flow.hcl', error: expect.stringMatching(/lowercase/) });
  });

  it('keeps name + label on a validity-failing flow (openable in the editor for fixing)', async () => {
    await seed('odd.hcl', 'flow "odd" {\n  label = "Odd"\n\n  stage {\n    name = "not-a-stage"\n  }\n}\n');
    expect(await listRepoFlows(repo)).toEqual([
      { file: 'odd.hcl', name: 'odd', label: 'Odd', error: expect.stringMatching(/unknown stage "not-a-stage"/) as unknown as string },
    ]);
  });

  it('flags a zero-stage flow', async () => {
    await seed('empty.hcl', 'flow "empty" {\n  label = "E"\n}\n');
    const [entry] = await listRepoFlows(repo);
    expect(entry?.error).toMatch(/at least one stage/);
  });

  it('flags BOTH files of a duplicate declaration', async () => {
    await seed('a.hcl', HEALTHY);
    await seed('b.hcl', HEALTHY.replace('"Mine"', '"Other"'));
    const entries = await listRepoFlows(repo);
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.error).toMatch(/duplicate flow "my-flow"/);
  });

  it('flags a flow shadowing a built-in', async () => {
    await seed('plan.hcl', HEALTHY.replace('"my-flow"', '"plan"'));
    const [entry] = await listRepoFlows(repo);
    expect(entry?.error).toMatch(/shadows a built-in/);
  });
});

describe('resolveRepoFlow / assertFlowResolvable', () => {
  it('resolves a repo flow to lowered stages (library identity + HCL override)', async () => {
    await seed('my-flow.hcl', HEALTHY);
    const stages = await resolveRepoFlow('my-flow', repo);
    expect(stages?.map((s) => s.name)).toEqual(['implementer']);
    expect(stages?.[0]?.model).toBe('sonnet');
    expect((stages?.[0]?.promptTemplate.length ?? 0) > 0).toBe(true);
  });

  it('returns undefined when no valid file declares the name', async () => {
    await seed('my-flow.hcl', HEALTHY);
    expect(await resolveRepoFlow('other', repo)).toBeUndefined();
  });

  it('a broken scratch file does not brick unrelated flows', async () => {
    await seed('my-flow.hcl', HEALTHY);
    await seed('scratch.hcl', 'flow "scratch" { label = ');
    expect((await resolveRepoFlow('my-flow', repo))?.map((s) => s.name)).toEqual(['implementer']);
  });

  it('throws naming both files on a duplicate declaration — resolve AND the fail-fast', async () => {
    await seed('a.hcl', HEALTHY);
    await seed('b.hcl', HEALTHY);
    await expect(resolveRepoFlow('my-flow', repo)).rejects.toThrow(/declared in both a\.hcl and b\.hcl/);
    await expect(assertFlowResolvable('my-flow', repo)).rejects.toThrow(/declared in both/);
  });

  it('assertFlowResolvable passes built-ins via own-property semantics, not the prototype chain', async () => {
    await expect(assertFlowResolvable('flow-b', repo)).resolves.toBeUndefined();
    // 'toString' is a Object.prototype key — a plain FLOWS[flow] lookup would pass it and burn a sandbox
    await expect(assertFlowResolvable('toString', repo)).rejects.toThrow(/unknown flow "toString"/);
  });

  it('passes a valid repo flow and rejects an unknown one listing built-ins + valid repo names', async () => {
    await seed('my-flow.hcl', HEALTHY);
    await expect(assertFlowResolvable('my-flow', repo)).resolves.toBeUndefined();
    const err = await unknownFlowError('nope', repo);
    expect(err).toBeInstanceOf(FlowError);
    expect(err.message).toMatch(/unknown flow "nope" — choose one of: default, plan, flow-b, my-flow/);
  });
});

describe('readRepoFlow', () => {
  it('returns the raw source + parsed doc', async () => {
    await seed('my-flow.hcl', HEALTHY);
    const { doc, source } = await readRepoFlow(repo, 'my-flow.hcl');
    expect(source).toBe(HEALTHY);
    expect(doc.name).toBe('my-flow');
    expect(doc.stages[0]).toEqual({ name: 'implementer', overrides: { model: 'sonnet' } });
  });

  it('returns the doc even when semantically invalid — the editor is how a broken flow gets fixed', async () => {
    await seed('odd.hcl', 'flow "odd" {\n  label = "Odd"\n\n  stage {\n    name = "not-a-stage"\n  }\n}\n');
    const { doc } = await readRepoFlow(repo, 'odd.hcl');
    expect(doc.stages[0]?.name).toBe('not-a-stage');
  });

  it('maps a missing file and a parse failure to FlowError (bad-request), not internal', async () => {
    await expect(readRepoFlow(repo, 'nope.hcl')).rejects.toThrow(FlowError);
    await seed('broken.hcl', 'flow "broken" { label = ');
    await expect(readRepoFlow(repo, 'broken.hcl')).rejects.toThrow(FlowError);
  });
});

describe('writeRepoFlow', () => {
  const DOC: FlowDoc = {
    name: 'my-flow',
    label: 'Mine',
    stages: [{ name: 'implementer', overrides: { model: 'sonnet' } }],
    loops: [],
  };

  it('creates .vanguard/flows on first save in a fresh repo and writes the canonical source', async () => {
    const { source } = await writeRepoFlow(repo, 'my-flow.hcl', DOC);
    expect(await readFile(join(flowsDir(), 'my-flow.hcl'), 'utf8')).toBe(source);
    const { doc } = await readRepoFlow(repo, 'my-flow.hcl');
    expect(doc).toEqual(DOC);
  });

  it('leaves no temp file behind, and the dot-prefixed temp name is invisible to discovery', async () => {
    await writeRepoFlow(repo, 'my-flow.hcl', DOC);
    expect(await readdir(flowsDir())).toEqual(['my-flow.hcl']);
    // even if a kill leaked one, discovery must not list it: dotfiles fail the filename rule
    await writeFile(join(flowsDir(), '.my-flow.hcl.tmp'), 'junk', 'utf8');
    expect((await listRepoFlows(repo)).map((f) => f.file)).toEqual(['my-flow.hcl']);
  });

  it('rejects when ANOTHER file already declares the flow name', async () => {
    await seed('other.hcl', HEALTHY); // declares "my-flow"
    await expect(writeRepoFlow(repo, 'my-flow.hcl', DOC)).rejects.toThrow(/already declared in other\.hcl/);
  });

  it('overwriting the SAME file is not a duplicate', async () => {
    await writeRepoFlow(repo, 'my-flow.hcl', DOC);
    await expect(writeRepoFlow(repo, 'my-flow.hcl', { ...DOC, label: 'Renamed' })).resolves.toBeTruthy();
  });

  it('refuses to write a file its own readFlow could not read back (template syntax → FlowError)', async () => {
    await expect(
      writeRepoFlow(repo, 'my-flow.hcl', { ...DOC, label: 'oops ${' }),
    ).rejects.toThrow(FlowError);
    await expect(readdir(flowsDir()).catch(() => 'absent')).resolves.toBe('absent'); // nothing written
  });
});

describe('flowDocError (the one validity predicate)', () => {
  it.each<[string, FlowDoc, RegExp]>([
    ['a name outside the grammar', { name: 'My Flow', label: 'L', stages: [{ name: 'planner', overrides: {} }], loops: [] }, /must be lowercase/],
    ['zero stages', { name: 'f', label: 'L', stages: [], loops: [] }, /at least one stage/],
    ['an unknown stage with no ref', { name: 'f', label: 'L', stages: [{ name: 'nope', overrides: {} }], loops: [] }, /unknown stage "nope"/],
  ])('rejects %s', (_label, doc, re) => {
    expect(flowDocError(doc)).toMatch(re);
  });

  it('accepts library stages and ref stages', () => {
    expect(
      flowDocError({
        name: 'f',
        label: 'L',
        stages: [
          { name: 'reviewer', overrides: {} }, // S5 palette widening
          { name: 'anything', ref: 'scripts/x.ts#stage', overrides: {} },
        ],
        loops: [],
      }),
    ).toBeUndefined();
  });
});

describe('coerceFlowDoc (write-path shape check — never a silent drop)', () => {
  const raw = (): Record<string, unknown> => ({
    name: 'f',
    label: 'L',
    stages: [{ name: 'planner', overrides: {} }],
    loops: [],
  });

  test('passes a clean doc through, preserving meta verbatim', () => {
    const meta = { anything: { goes: [1, 'here', null] } };
    const stageMeta = { note: 'hi' };
    const input = { ...raw(), meta, stages: [{ name: 'planner', overrides: {}, meta: stageMeta }] };
    expect(coerceFlowDoc(input)).toEqual({ name: 'f', label: 'L', loops: [], meta, stages: [{ name: 'planner', overrides: {}, meta: stageMeta }] });
  });

  test.each<[string, Record<string, unknown>, RegExp]>([
    ['an unknown doc key', { ...raw(), position: { x: 1 } }, /unknown key "position" in doc/],
    ['an unknown stage key (the silent-drop class)', { ...raw(), stages: [{ name: 'planner', overrides: {}, timeoutMs: 5 }] }, /unknown key "timeoutMs"/],
    ['an unknown override key', { ...raw(), stages: [{ name: 'planner', overrides: { foo: 1 } }] }, /unknown key "foo"/],
    ['an unknown loop key', { ...raw(), loops: [{ stages: ['a'], until: 'x', max: 1, jitter: true }] }, /unknown key "jitter"/],
    ['a bad effort', { ...raw(), stages: [{ name: 'planner', overrides: { effort: 'ultra' } }] }, /effort must be/],
    ['a fractional maxTurns', { ...raw(), stages: [{ name: 'planner', overrides: { maxTurns: 2.5 } }] }, /positive integer/],
    ['a non-boolean resumePrevious', { ...raw(), stages: [{ name: 'planner', overrides: { resumePrevious: 'yes' } }] }, /must be a boolean/],
    ['a blank name', { ...raw(), name: ' ' }, /name must be a non-blank string/],
    ['a missing label', { ...raw(), label: undefined }, /label must be a non-blank string/],
    ['non-array stages', { ...raw(), stages: 'planner' }, /stages must be an array/],
    ['a non-object meta', { ...raw(), meta: 'x' }, /meta must be an object/],
  ])('rejects %s', (_label, input, re) => {
    expect(() => coerceFlowDoc(input)).toThrow(re);
    expect(() => coerceFlowDoc(input)).toThrow(FlowError);
  });
});

describe('prototype-key stage names (review #336 finding 1)', () => {
  const protoDoc = (stage: string): FlowDoc => ({
    name: 'f',
    label: 'L',
    stages: [{ name: stage, overrides: {} }],
    loops: [],
  });

  it.each(['toString', 'valueOf', 'constructor', 'hasOwnProperty'])(
    'flowDocError rejects a stage named %s — STAGE_LIBRARY inherits Object.prototype',
    (stage) => {
      expect(flowDocError(protoDoc(stage))).toMatch(new RegExp(`unknown stage "${stage}"`));
    },
  );
});

describe('duplicate semantics are valid-only everywhere (review #336 finding 2)', () => {
  const INVALID_SAME_NAME = 'flow "my-flow" {\n  label = "Broken twin"\n\n  stage {\n    name = "not-a-stage"\n  }\n}\n';

  it('an invalid sibling declaring the name does not mark the valid file as a duplicate', async () => {
    await seed('my-flow.hcl', HEALTHY);
    await seed('twin.hcl', INVALID_SAME_NAME);
    const entries = await listRepoFlows(repo);
    expect(entries.find((e) => e.file === 'my-flow.hcl')?.error).toBeUndefined();
    expect(entries.find((e) => e.file === 'twin.hcl')?.error).toMatch(/unknown stage/);
  });

  it('an invalid sibling declaring the name does not block writing the valid flow', async () => {
    await seed('twin.hcl', INVALID_SAME_NAME);
    await expect(
      writeRepoFlow(repo, 'my-flow.hcl', {
        name: 'my-flow',
        label: 'Mine',
        stages: [{ name: 'implementer', overrides: {} }],
        loops: [],
      }),
    ).resolves.toBeTruthy();
  });
});

describe('deleteRepoFlow (S8)', () => {
  it('deletes an existing flow file', async () => {
    await seed('my-flow.hcl', HEALTHY);
    await deleteRepoFlow(repo, 'my-flow.hcl');
    expect(await listRepoFlows(repo)).toEqual([]);
  });

  it('is idempotent: ENOENT is success (a Timed retry of a killed delete must not scare anyone)', async () => {
    await expect(deleteRepoFlow(repo, 'never-existed.hcl')).resolves.toBeUndefined();
  });

  it('rejects a name outside the flow-file grammar (no traversal, no dotfiles)', async () => {
    await expect(deleteRepoFlow(repo, '../escape.hcl')).rejects.toThrow(FlowError);
    await expect(deleteRepoFlow(repo, '.hidden.hcl')).rejects.toThrow(FlowError);
    await expect(deleteRepoFlow(repo, 'not-hcl.txt')).rejects.toThrow(FlowError);
  });

  it('maps a non-ENOENT failure to FlowError (delete target is a directory)', async () => {
    await mkdir(join(flowsDir(), 'dir.hcl'), { recursive: true });
    await expect(deleteRepoFlow(repo, 'dir.hcl')).rejects.toThrow(FlowError);
  });
});
