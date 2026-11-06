/** A refusal under the contract's `malformed` verdict (#2553 DoR §2.3, §2.13). */
export class Malformed extends Error {
  readonly reason = 'malformed';

  constructor(detail: string) {
    super(`malformed: ${detail}`);
    this.name = 'Malformed';
  }
}
