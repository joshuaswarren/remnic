/**
 * Sampling gate for the extraction span benchmark (issue #2333).
 *
 * Pure predicate, deliberately standalone: it does not import the extraction
 * engine and is not wired into the default extraction path. A future caller
 * opts in explicitly; until then this module changes nothing at runtime.
 */

export interface SpanBenchOptions {
	enabled: boolean;
	sampleRate: number;
}

export function shouldRunSpanBench({ enabled, sampleRate }: SpanBenchOptions): boolean {
	if (
		typeof sampleRate !== "number" ||
		!Number.isFinite(sampleRate) ||
		sampleRate < 0 ||
		sampleRate > 1
	) {
		throw new Error(
			`extraction-span-bench: sampleRate must be a finite number in [0, 1], got ${String(sampleRate)}`,
		);
	}
	if (!enabled || sampleRate === 0) return false;
	if (sampleRate === 1) return true;
	return Math.random() < sampleRate;
}
