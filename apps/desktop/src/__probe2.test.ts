import { test, expect } from 'vitest';
import { createHubServer } from '../../../src/hub/server.js';

test('cross-package import resolves', () => {
  expect(typeof createHubServer).toBe('function');
});
