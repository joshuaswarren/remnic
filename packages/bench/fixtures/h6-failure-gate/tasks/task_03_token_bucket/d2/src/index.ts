export class TokenBucket {

  constructor(public readonly capacity: number, public readonly refillRatePerSec: number) {
    this.tokens = capacity;
  }

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  public tryConsume(): boolean {
  private tokens: number;
}
