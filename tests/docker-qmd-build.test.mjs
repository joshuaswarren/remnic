import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercises the actual Dockerfile shell gate with a real npm build, not an image build.
test('QMD explicit build is opt-in, validates values, and propagates build failures', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.ok(dockerfile.includes('ARG QMD_EXPLICIT_BUILD=false'));
  const gate = dockerfile.split('\n').find((line) => line.includes('case "$QMD_EXPLICIT_BUILD"'));
  assert.ok(gate, 'Dockerfile must gate the explicit build');
  assert.ok(dockerfile.indexOf(gate) < dockerfile.indexOf('&& npm pack /tmp/qmd'));
  const dir = mkdtempSync(join(tmpdir(), 'remnic-qmd-build-'));
  const manifest = join(dir, 'package.json');
  const marker = join(dir, 'built');
  const command = gate.trim().replace(/^&& /, '').replace(/ \\$/, '').replace('/tmp/qmd', JSON.stringify(dir));
  const run = (value) => spawnSync('sh', ['-ec', command], {
    encoding: 'utf8',
    env: { ...process.env, QMD_EXPLICIT_BUILD: value },
    timeout: 30_000,
  });
  try {
    writeFileSync(manifest, JSON.stringify({ scripts: {
      build: 'node -e "require(\'node:fs\').writeFileSync(\'built\', \'yes\')"',
    } }));
    assert.equal(run('false').status, 0);
    assert.equal(existsSync(marker), false);
    const enabled = run('true');
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'yes');
    const invalid = run('typo');
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /must be true or false/);
    writeFileSync(manifest, JSON.stringify({ scripts: { build: 'node -e "process.exit(23)"' } }));
    assert.equal(run('true').status, 23);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
