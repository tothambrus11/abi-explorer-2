// What the query was answered against, in words.
//
// Which headers resolved is not a detail: a target musl has no tree for gets
// portable C declarations over that target's own scalar types and no locale
// layer, so `<iostream>` compiles on Linux and not on Darwin. The reason
// should be readable somewhere rather than guessed from the error.
//
// Pure, and here rather than in the footer, because two places show it now:
// the footer on a wide screen, and the top bar's details popover on a phone.

import type { WireHeaders } from './render';

/** One line: `libc++ · musl (x86_64)`. Empty when nothing resolved. */
export function headerSummary(h: WireHeaders | null): string {
  if (!h?.cLibrary) return '';
  const tree = h.cLibraryArch === 'generic' ? 'portable' : (h.cLibraryArch ?? '');
  const cxx = h.cxxLibrary ? `${h.cxxLibrary} · ` : '';
  return `${cxx}${h.cLibrary}${tree ? ` (${tree})` : ''}`;
}

/** The paragraph behind it: what that means, and what is missing. Null when nothing resolved. */
export function headerExplanation(h: WireHeaders | null): string | null {
  if (!h?.cLibrary) return null;
  if (h.cLibraryArch !== 'generic') {
    // Without a C++ library (a C query), "none over musl's own tree" is not
    // a sentence. Name what is there instead of what is not.
    const tree = `musl's own ${h.cLibraryArch ?? 'target'} tree`;
    return (
      `Standard headers for this target: ${h.cxxLibrary ? `${h.cxxLibrary} over ${tree}` : tree}` +
      `, complete with the operating-system structures like struct stat.`
    );
  }
  const missing = [
    'operating-system headers such as <sys/stat.h>',
    ...(h.localization
      ? []
      : ["<locale> and <iostream>, whose implementation needs this platform's own locale API"]),
    ...(h.threads ? [] : ['<thread> and <mutex>: this target has no operating system']),
  ];
  return (
    `musl has no header tree for this target, so the C declarations are its portable ones over ` +
    `this target's own scalar types. Every size and alignment is right for it. Not available here: ` +
    missing.join('; ') +
    '.'
  );
}
