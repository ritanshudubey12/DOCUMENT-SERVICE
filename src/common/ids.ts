const EPOCH = 1704067200000n; // 2024-01-01T00:00:00Z
const MAX_SEQ = 4095n;

/**
 * Snowflake-style 64-bit id generator: 41 bits time | 10 bits node | 12 bits sequence.
 * Result always fits in a signed BIGINT and is returned as a decimal string.
 */
export class Snowflake {
  private last = -1n;
  private seq = 0n;

  constructor(private readonly nodeId: bigint) {
    if (nodeId < 0n || nodeId > 1023n) throw new Error('Snowflake node id must be between 0 and 1023');
  }

  next(): string {
    let now = BigInt(Date.now());
    if (now < this.last) now = this.last; // clock moved backwards: keep monotonic
    if (now === this.last) {
      this.seq = (this.seq + 1n) & MAX_SEQ;
      if (this.seq === 0n) {
        while (now <= this.last) now = BigInt(Date.now()); // sequence exhausted: wait for next ms
      }
    } else {
      this.seq = 0n;
    }
    this.last = now;
    return (((now - EPOCH) << 22n) | (this.nodeId << 12n) | this.seq).toString();
  }
}
