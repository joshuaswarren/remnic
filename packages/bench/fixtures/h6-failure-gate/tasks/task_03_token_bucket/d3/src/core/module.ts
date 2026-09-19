export class TokenBucket {
  private tokens: number;

  constructor(public readonly capacity: number, public readonly refillRatePerSec: number) {
    this.tokens = capacity;
  }

  public tryConsume(): boolean {
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
