// Whether to ask before pulling the ~27 MB clang bundle over the network.
//
// The decision is pure and dependency-injected so it can be tested without a
// browser: a connection hint (Network Information API), the persisted consent,
// and whether the bundle is already available locally (vendored or cached).

/** The bits of `navigator.connection` we use; all optional (Safari/Firefox lack it). */
export interface ConnectionHint {
  /** User asked for reduced data use ("Data Saver"). */
  saveData?: boolean | undefined;
  /** 'slow-2g' | '2g' | '3g' | '4g' — a round-trip/bandwidth estimate, not the medium. */
  effectiveType?: string | undefined;
  /** 'cellular' | 'wifi' | 'ethernet' | … (rarely implemented). */
  type?: string | undefined;
}

/**
 * A connection we should not spend ten-odd megabytes on without asking: the
 * user turned on Data Saver, the browser reports a cellular link, or the link
 * is slow enough that the download would take minutes.
 */
export function isMeteredConnection(c: ConnectionHint | null | undefined): boolean {
  if (!c) return false; // no information → assume unmetered (the common desktop case)
  if (c.saveData === true) return true;
  if (c.type === 'cellular') return true;
  return c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
}

export interface ConsentInputs {
  connection: ConnectionHint | null | undefined;
  /** The user previously opted in (persisted). */
  consented: boolean;
  /** The bundle is vendored or already in the Cache API — nothing large to fetch. */
  availableLocally: boolean;
}

/** Ask before downloading? Only on a metered link, with no consent and no local copy. */
export function needsDownloadConsent(i: ConsentInputs): boolean {
  if (i.availableLocally) return false;
  if (i.consented) return false;
  return isMeteredConnection(i.connection);
}
