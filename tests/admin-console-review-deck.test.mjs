/**
 * Bridge so the root test runner (which globs `tests/**` only) also runs the
 * review-deck state-machine suite that lives next to the console source it
 * covers. The suite itself is runnable standalone:
 *
 *   node admin-console/public/review-deck.test.mjs
 */
import "../admin-console/public/review-deck.test.mjs";
