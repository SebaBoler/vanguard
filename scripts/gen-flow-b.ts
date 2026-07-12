#!/usr/bin/env tsx
// Regenerate src/flows/flow-b.hcl from the registered flow via the emitter. The checked-in file is
// the format fixture + Subsystem 5 seed; roundtrip.test.ts asserts it stays in sync. Re-run after
// changing planImplementAdversaryStages: `pnpm tsx scripts/gen-flow-b.ts`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FLOWS } from '../src/api/capabilities.js';
import { emitFlowHcl } from '../src/flows/emit.js';

const entry = FLOWS['flow-b']!;
const hcl = emitFlowHcl(entry.build(), { name: 'flow-b', label: entry.label });
const out = fileURLToPath(new URL('../src/flows/flow-b.hcl', import.meta.url));
writeFileSync(out, hcl);
process.stdout.write(`wrote ${out}\n`);
