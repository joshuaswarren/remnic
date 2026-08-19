import assert from "node:assert/strict";
import test from "node:test";

import { shouldRunSpanBench } from "./extraction-span-bench.js";

test("shouldRunSpanBench: disabled or zero rate never samples (issue #2333)", () => {
	assert.equal(shouldRunSpanBench({ enabled: false, sampleRate: 1 }), false);
	assert.equal(shouldRunSpanBench({ enabled: false, sampleRate: 0 }), false);
	assert.equal(shouldRunSpanBench({ enabled: true, sampleRate: 0 }), false);
});

test("shouldRunSpanBench: enabled with full rate always samples (issue #2333)", () => {
	assert.equal(shouldRunSpanBench({ enabled: true, sampleRate: 1 }), true);
});

test("shouldRunSpanBench: rejects sampleRate outside [0, 1] or non-finite (issue #2333)", () => {
	const invalid: number[] = [-0.1, 1.0001, Number.NaN, Number.POSITIVE_INFINITY];
	for (const sampleRate of invalid) {
		assert.throws(() => shouldRunSpanBench({ enabled: true, sampleRate }));
	}
	assert.throws(() =>
		shouldRunSpanBench({ enabled: true, sampleRate: "0.5" as unknown as number }),
	);
	assert.throws(() =>
		shouldRunSpanBench({ enabled: true, sampleRate: undefined as unknown as number }),
	);
});
