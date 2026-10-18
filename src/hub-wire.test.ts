import { describe, expect, it } from 'vitest';
import { decodeResponse, encodeError, encodeEvent, encodeResult, STREAM_RESET_EVENT } from './hub-wire.js';

describe('hub RPC codec', () => {
  it.each([undefined, null, false, 0, '', [], { projects: [] }])('round trips result %j', (value) => {
    const body: unknown = JSON.parse(JSON.stringify(encodeResult(value)));
    expect(decodeResponse(200, body)).toEqual(value ?? null);
  });

  it.each([null, false, [], {}, { projects: [] }, { result: undefined }, Object.create({ result: 1 })])(
    'rejects a malformed success body %j',
    (body) => {
      expect(() => decodeResponse(200, body)).toThrow('hub response body is missing "result"');
    },
  );

  it.each(['bad-request', 'internal'] as const)('round trips a %s error', (kind) => {
    const { status, body } = encodeError({ kind, message: 'failed' });
    expect(status).toBe(kind === 'bad-request' ? 400 : 500);
    expect(() => decodeResponse(status, body)).toThrow('failed');
  });

  it('preserves explicit HTTP error statuses', () => {
    expect(encodeError({ kind: 'bad-request', message: 'missing' }, 404).status).toBe(404);
  });

  it.each([null, {}, { error: null }, { error: { message: 123 } }])(
    'falls back to the HTTP status for malformed errors %j',
    (body) => {
      expect(() => decodeResponse(503, body)).toThrow('request failed with status 503');
    },
  );
});

describe('hub SSE codec', () => {
  it('keeps payload newlines inside a single JSON data line', () => {
    expect(encodeEvent(42, 'api:event', { text: 'a\nb' }))
      .toBe('id: 42\nevent: api:event\ndata: {"text":"a\\nb"}\n\n');
  });

  it('omits the replay ID from stream reset frames', () => {
    expect(encodeEvent(undefined, STREAM_RESET_EVENT, {})).toBe('event: stream-reset\ndata: {}\n\n');
  });
});
