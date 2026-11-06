// §2.8's assurance order and the segment rules a co-member checks (D-182,
// LD-35, D-254). `DeriveAssurance` and `Floor` are authority-only and are not
// ported: a client checks a result's label against the §2.9 column, never
// derives one.

/** §2.8's four segment labels. */
export const SEGMENTS: readonly string[] = Object.freeze([
  'initial',
  'continuity',
  'recovery',
  'unverified',
]);

/** initial = continuity > recovery > unverified; "" and any unknown value rank 0. */
export function rank(a: string): number {
  switch (a) {
    case 'initial':
    case 'continuity':
      return 3;
    case 'recovery':
      return 2;
    case 'unverified':
      return 1;
  }
  return 0;
}

/** a, or limit when a is stronger than limit. */
export const capAt = (a: string, limit: string): string => (rank(a) > rank(limit) ? limit : a);

/** rotate_root's rule: continuity if the segment opened as initial or continuity, else the segment's own label. */
export const segmentRule = (seg: string): string => (rank(seg) === 3 ? 'continuity' : seg);

/** A segment the caller does not know ("" included) is unverified (§2.8 monitor rule). */
export const knownSegment = (seg: string): string => (SEGMENTS.includes(seg) ? seg : 'unverified');
