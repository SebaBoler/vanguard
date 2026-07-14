import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from './Settings';
import * as ipc from '../../ipc';

vi.mock('../../ipc.js', () => ({
  readAppConfig: vi.fn(async () => ({})),
  writeAppConfig: vi.fn(async () => {}),
}));

const read = vi.mocked(ipc.readAppConfig);
const write = vi.mocked(ipc.writeAppConfig);

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('Save is disabled until the config read resolves — an early save must not write the {} seed (S6 guard a)', async () => {
  const gate = deferred<Record<string, never>>();
  read.mockReturnValueOnce(gate.promise);
  render(<Settings project="/repo" />);
  // dirty the form while the read is still in flight
  fireEvent.change(screen.getByPlaceholderText('vanguard-ready'), { target: { value: 'x' } });
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  gate.resolve({});
  await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled());
});

test('an unreadable config surfaces an error and blocks save instead of silently defaulting (S6 guard b)', async () => {
  read.mockRejectedValueOnce(new Error('.vanguard/app.json is unreadable: expected value at line 1'));
  render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByText(/app\.json is unreadable/i)).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('vanguard-ready'), { target: { value: 'x' } });
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  expect(write).not.toHaveBeenCalled();
});

test('an invalid custom-provider row blocks save with an inline message', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /add/i }));
  // a fresh empty row is invalid (empty name) — save blocked, message shown
  expect(await screen.findByText(/name must be lowercase/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
});

test('a valid custom-provider row saves through writeAppConfig with only name/baseUrl/keyEnv/model', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /add/i }));
  fireEvent.change(screen.getAllByRole('textbox').find((el) => el.closest('label')?.textContent?.startsWith('name'))!, {
    target: { value: 'my-proxy' },
  });
  fireEvent.change(screen.getByPlaceholderText('MY_PROXY_API_KEY'), { target: { value: 'MY_KEY' } });
  fireEvent.change(screen.getByPlaceholderText('https://llm.example.com/api'), {
    target: { value: 'https://llm.example.com/api' },
  });
  const save = screen.getByRole('button', { name: /save/i });
  await waitFor(() => expect(save).not.toBeDisabled());
  fireEvent.click(save);
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        customProviders: [{ name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_KEY' }],
      }),
    ),
  );
});

test('a dangling cfg.provider renders flagged instead of silently blanking', async () => {
  read.mockResolvedValueOnce({ provider: 'gone-proxy' });
  render(<Settings project="/repo" />);
  expect(await screen.findByText('gone-proxy (not configured)')).toBeInTheDocument();
});

test('the provider dropdown offers healthy customs; reviewProvider stays built-ins-only', async () => {
  read.mockResolvedValueOnce({
    customProviders: [{ name: 'my-proxy', baseUrl: 'https://llm.example.com', keyEnv: 'K' }],
  });
  render(<Settings project="/repo" />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  const providerSelect = screen.getByText('provider').closest('label')!.querySelector('select')!;
  const reviewSelect = screen.getByText('reviewProvider').closest('label')!.querySelector('select')!;
  const values = (sel: HTMLSelectElement): string[] => [...sel.options].map((o) => o.value).filter(Boolean);
  expect(values(providerSelect)).toContain('my-proxy');
  expect(values(reviewSelect)).not.toContain('my-proxy');
});
