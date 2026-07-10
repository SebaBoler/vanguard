import { describe, expect, it } from 'vitest';
import { autoColor, contrastColor, hslToHex, isValidHexColor, projectColor } from './color';

describe('color', () => {
  it('hslToHex hits known anchors', () => {
    expect(hslToHex(0, 0, 0)).toBe('#000000');
    expect(hslToHex(0, 0, 100)).toBe('#ffffff');
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
    expect(hslToHex(120, 100, 50)).toBe('#00ff00');
    expect(hslToHex(240, 100, 50)).toBe('#0000ff');
  });

  it('autoColor is deterministic and a valid hex', () => {
    const a = autoColor('/repos/modelbox');
    expect(a).toBe(autoColor('/repos/modelbox'));
    expect(isValidHexColor(a)).toBe(true);
    // different seeds → (near-certainly) different colors
    expect(autoColor('/repos/vanguard')).not.toBe(a);
  });

  it('projectColor prefers a valid override, falls back to auto', () => {
    expect(projectColor({ path: '/x', color: '#123abc' })).toBe('#123abc');
    expect(projectColor({ path: '/x', color: 'not-hex' })).toBe(autoColor('/x'));
    expect(projectColor({ path: '/x' })).toBe(autoColor('/x'));
  });

  it('contrastColor picks black on light, white on dark', () => {
    expect(contrastColor('#ffffff')).toBe('#000000');
    expect(contrastColor('#000000')).toBe('#ffffff');
    expect(contrastColor('#f5d90a')).toBe('#000000'); // bright yellow → black text
    expect(contrastColor('#1a2b8c')).toBe('#ffffff'); // deep blue → white text
  });
});
