import { describe, it, expect } from 'vitest';
import { isMeteredConnection, needsDownloadConsent } from '$core/metered';

describe('isMeteredConnection', () => {
  it('treats a missing Network Information API as unmetered', () => {
    expect(isMeteredConnection(null)).toBe(false);
    expect(isMeteredConnection(undefined)).toBe(false);
    expect(isMeteredConnection({})).toBe(false);
  });

  it('honours Data Saver above everything else', () => {
    expect(isMeteredConnection({ saveData: true, effectiveType: '4g', type: 'wifi' })).toBe(true);
  });

  it('treats a cellular link as metered even when fast', () => {
    expect(isMeteredConnection({ type: 'cellular', effectiveType: '4g' })).toBe(true);
  });

  it('treats slow links as metered, fast ones as not', () => {
    expect(isMeteredConnection({ effectiveType: 'slow-2g' })).toBe(true);
    expect(isMeteredConnection({ effectiveType: '2g' })).toBe(true);
    expect(isMeteredConnection({ effectiveType: '3g' })).toBe(true);
    expect(isMeteredConnection({ effectiveType: '4g' })).toBe(false);
    expect(isMeteredConnection({ type: 'wifi', effectiveType: '4g' })).toBe(false);
  });
});

describe('needsDownloadConsent', () => {
  const metered = { saveData: true };

  it('asks on a metered link with no consent and no local copy', () => {
    expect(
      needsDownloadConsent({ connection: metered, consented: false, availableLocally: false }),
    ).toBe(true);
  });

  it('never asks when the bundle is already local (vendored or cached)', () => {
    expect(
      needsDownloadConsent({ connection: metered, consented: false, availableLocally: true }),
    ).toBe(false);
  });

  it('never asks again once the user consented', () => {
    expect(
      needsDownloadConsent({ connection: metered, consented: true, availableLocally: false }),
    ).toBe(false);
  });

  it('never asks on an unmetered link', () => {
    expect(
      needsDownloadConsent({
        connection: { effectiveType: '4g' },
        consented: false,
        availableLocally: false,
      }),
    ).toBe(false);
    expect(
      needsDownloadConsent({ connection: null, consented: false, availableLocally: false }),
    ).toBe(false);
  });
});
