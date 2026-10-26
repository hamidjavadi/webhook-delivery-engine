import { describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './actions.js';

describe('demo UI actions', () => {
  it('copies the exact supplied value and reports clipboard failures', async () => {
    const writeText = vi.fn(async (_value: string) => undefined);

    expect(await copyToClipboard('{"type":"example"}', writeText)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('{"type":"example"}');
    expect(await copyToClipboard('value', vi.fn(async () => { throw new Error('denied'); }))).toBe(false);
  });

});
