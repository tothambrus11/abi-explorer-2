import { describe, expect, it } from 'vitest';
import { memberColor, PADDING_COLOR } from '@abi-explorer/shared/layoutModel';

/** WCAG's contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((start) => {
      const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

// The light and dark backgrounds of common themes: VS Code's Light+ and Dark+, Zed's One Dark.
const LIGHT = '#ffffff';
const DARK = ['#1e1e1e', '#282c34'];

describe('the member colours', () => {
  const colors = [...Array(8).keys()].map(memberColor);

  it('carry white letters', () => {
    for (const color of colors) expect(contrast(color, '#ffffff')).toBeGreaterThan(4);
  });

  it('read as text on light and dark themes', () => {
    for (const color of [...colors, PADDING_COLOR]) {
      expect(contrast(color, LIGHT)).toBeGreaterThan(4);
      for (const background of DARK) expect(contrast(color, background)).toBeGreaterThan(3.2);
    }
  });
});
