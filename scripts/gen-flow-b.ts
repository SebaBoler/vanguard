#!/usr/bin/env tsx
// Regenerate src/flows/flow-b.hcl from the TS builder via the emitter. The checked-in file is the
// format fixture + Subsystem 5 seed; a test (roundtrip.test.ts) asserts it stays in sync. Re-run
// after changing planImplementAdversaryStages: `pnpm tsx scripts/gen-flow-b.ts`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planImplementAdversaryStages } from '../src/pipeline/pipeline.js';
import { emitFlowHcl } from '../src/flows/emit.js';
import { FLOW_B_LABEL } from '../src/flows/flow-b-label.js';

const hcl = emitFlowHcl(planImplementAdversaryStages(), { name: 'flow-b', label: FLOW_B_LABEL });
const out = fileURLToPath(new URL('../src/flows/flow-b.hcl', import.meta.url));
writeFileSync(out, hcl);
process.stdout.write(`wrote ${out}\n`);
