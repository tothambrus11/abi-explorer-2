# @ambrus-toth/abi-explorer-share-link

The URL fragment an [ABI Explorer](https://abiexplorer.org) link shares a
session in: the session state (`ShareState`), every version of the wire
format it travels as (`WireV1`, `WireV2`, `WireV3`; `Wire` is their union),
the envelopes a wire travels in, and one reader for all of it. No
dependencies; runs anywhere `CompressionStream`, `btoa` and `TextEncoder`
exist (browsers, Node 18+, Deno, Bun).

```ts
import { encode, decode } from '@ambrus-toth/abi-explorer-share-link';

const url = `https://abiexplorer.org/#${await encode(state)}`;
const back = await decode(location.hash); // ShareState | null
```

A program that only writes links imports `./encode` and carries no reader;
one that only reads imports `./decode` and carries no writer:

```ts
import { encode } from '@ambrus-toth/abi-explorer-share-link/encode';
import { decode } from '@ambrus-toth/abi-explorer-share-link/decode';
```

## The pieces

`encode` is `toWireV3` in the smallest envelope the runtime can write;
`decode` is `decodeFragment` then `fromWire`. Each piece is exported for a
program that writes an older version, or reads a wire it got some other way.

| Wire | Shape                                                                      |
| ---- | -------------------------------------------------------------------------- |
| V1   | one source and its options at the top level; the plain-envelope era        |
| V2   | the same, numbered for the compressed envelope (abiexplorer.org, Sep 2026) |
| V3   | `bs`: every source with its own options; `vw` the view; `ly` the desk      |

`v` tells wires apart; a wire without one, or with one the reader does not
know, is read as V1, the oldest and most lenient. `toWireV1` and `toWireV2`
carry a state's first buffer only.

| Envelope | Form                                  |
| -------- | ------------------------------------- |
| 1        | `base64url(JSON)`                     |
| 2        | `"2." + base64url(deflate-raw(JSON))` |

A wire of any version travels in either envelope; `decodeFragment` tells them
apart by the prefix.

## What the readers promise

- They never throw; anything that is not a link is `null`.
- Every field of what they return has the right shape: strings where strings
  go, a known `pack`, a triple that is a plain token, booleans for the
  toggles, at most eight buffers, names of at most forty characters, a
  `layout` only when it has the shape of one.
- What the values _mean_ is the reader's to decide: which standards a
  language has, and which triple stands for which ABI, change with the
  compilers an app ships, so an unknown `lang`, `std` or `triple` comes
  through as it was written (or `''` when it was not a string) rather than
  being replaced with a default.
