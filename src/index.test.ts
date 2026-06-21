import { describe, it, expect } from 'vitest';
import * as api from './index.js';

describe('public quota exports', () => {
  it('exposes the quota routing surface', () => {
    expect(typeof api.quotaRoutedAgent).toBe('function');
    expect(typeof api.QuotaRoutingProvider).toBe('function');
    expect(typeof api.resolveModel).toBe('function');
    expect(typeof api.pctBucketCheck).toBe('function');
    expect(typeof api.zaiMonitorRefresh).toBe('function');
    expect(typeof api.worstWindow).toBe('function');
    expect(typeof api.readSnapshot).toBe('function');
    expect(typeof api.writeSnapshot).toBe('function');
    expect(typeof api.AllBucketsFlooredError).toBe('function');
  });
});
