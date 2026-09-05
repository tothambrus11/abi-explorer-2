// Every version of the wire, as one type: what a writer of any version
// produces, and what a reader may be handed. `v` tells them apart.

import type { WireV1 } from './v1.ts';
import type { WireV2 } from './v2.ts';
import type { WireV3 } from './v3.ts';

export type { WireV1 } from './v1.ts';
export type { WireV2 } from './v2.ts';
export type { WireV3 } from './v3.ts';

/** A wire of any version. */
export type Wire = WireV1 | WireV2 | WireV3;
