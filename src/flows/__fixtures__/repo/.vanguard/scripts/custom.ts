import type { PipelineStage } from '../../../../../../pipeline/pipeline.js';

/** A Layer-2 `ref =` fixture stage: proves an HCL flow can resolve a custom TS export by name. */
export const myStage: PipelineStage = {
  name: 'custom',
  promptTemplate: 'Do {{TITLE}} the custom way. When done, write <promise>COMPLETE</promise>.',
  maxTurns: 5,
};

/** A factory-form export, to prove `() => PipelineStage` also resolves. */
export function myFactoryStage(): PipelineStage {
  return { name: 'custom-factory', promptTemplate: 'factory {{TITLE}}', maxTurns: 7 };
}
