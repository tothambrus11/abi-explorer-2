import { describe, expect, it } from 'vitest';
import { MEMBER_COLORS, NOCTURNE } from '@abi-explorer/shared/layoutModel';

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

// The light and dark backgrounds of common themes: VS Code's Light+ and Dark+,
// Zed's One Dark, and Nocturne's own surface.
const LIGHT = '#ffffff';
const DARK = ['#1e1e1e', '#282c34', NOCTURNE.surface];

const members = (mode: 'dark' | 'light') =>
  Object.entries(MEMBER_COLORS[mode])
    .filter(([slot]) => slot !== 'c-special')
    .map(([, color]) => color);

describe('the member colours', () => {
  it('are the web explorer’s Nocturne palette on dark themes', () => {
    expect(members('dark')).toEqual([
      '#82aaff',
      '#f78c6c',
      '#7fdbca',
      '#ffcb6b',
      '#ff869a',
      '#addb67',
      '#c792ea',
      '#ef5350',
    ]);
  });

  it('stand out from the ground they are drawn on', () => {
    for (const color of members('dark')) {
      for (const background of DARK) expect(contrast(color, background)).toBeGreaterThan(3);
    }
    for (const color of members('light')) expect(contrast(color, LIGHT)).toBeGreaterThan(2);
  });

  it('label hover images in a grey that reads on light and dark themes', () => {
    expect(contrast(NOCTURNE.muted, LIGHT)).toBeGreaterThan(3);
    for (const background of DARK) expect(contrast(NOCTURNE.muted, background)).toBeGreaterThan(3);
  });
});
