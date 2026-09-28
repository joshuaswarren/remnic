/**
 * H1 outcome-prior recall blend (issue #1958).
 *
 * Both fields default off/zero. Recall ranking stays on the existing
 * boost path unless `outcomeBoostEnabled` is true and `outcomeBoostWeight`
 * is greater than 0.
 */
export interface OutcomeBoostConfig {
  /** Opt-in gate. Default false. */
  outcomeBoostEnabled: boolean;
  /**
   * Blend weight in [0, 1]. Absent config parses as 0, which does not
   * change scores. Invalid values throw.
   */
  outcomeBoostWeight: number;
}
