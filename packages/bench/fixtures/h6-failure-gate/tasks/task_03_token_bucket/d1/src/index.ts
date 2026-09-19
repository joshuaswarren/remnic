export class TokenBucket {
  private availableCapacity: number;

  constructor(public readonly capacity: number, public readonly refillRatePerSec: number) {
    this.availableCapacity = capacity;
  }

  public tryConsume(): boolean {
    if (this.availableCapacity >= 1) {
      this.availableCapacity -= 1;
      return true;
    }
    return false;
  }
}
