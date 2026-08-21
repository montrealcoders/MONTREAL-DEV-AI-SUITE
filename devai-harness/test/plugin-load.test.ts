/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Acceptance test of the embedded DEV-AI Harness (Phase 1): a third-party
 * dsh plugin — an npm-style package the harness has never seen, packed and
 * installed into the devai profile through the ecosystem's package-manager
 * flow — loads unmodified and its tool executes through the runtime's
 * `ctx.tools` pipeline.
 *
 * Plain Node, no model, no network beyond the local install. Exits 0 on
 * success, 1 on any failure (boot() itself fails loud when any composed
 * entry fails to load or activate).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const home = join(testDir, '..', '.tmp-test-home');
const fixtureDir = join(testDir, 'fixtures', 'dsh-plugin-greeter');

// A fresh harness home per run; DSH_HOME must be set before the boot module
// (and through it dsh-home-paths) is imported.
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;

const { bootDevaiHarness, ensureDevaiProfile } = await import('../src/boot.ts');

// 1. Seed the devai profile, then install the plugin into it through npm —
// the out-of-tree flow (`dsh plugin` forwards to a package manager in the
// profile directory). Packing first makes the install a real third-party
// artifact, not a symlink into this repository. --legacy-peer-deps skips
// auto-installing the plugin's dsh peer dependencies: peers must resolve
// through the healed profiles/node_modules fallback so every plugin shares
// the installation's single instance of each dsh package.
const profile = ensureDevaiProfile();
const tarball = execFileSync('npm', ['pack', '--silent', fixtureDir], { cwd: home, encoding: 'utf8' }).trim();
execFileSync('npm', [
	'install', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', '--legacy-peer-deps',
	join(home, tarball),
], { cwd: profile.dir, stdio: 'inherit' });

// 2. Boot the embedded runtime on the devai profile, with the plugin's entry
// added in the overlay slot (the dsh CLI's --patch layer). The plugin package
// itself is untouched.
const ctx = await bootDevaiHarness({
	overlays: [{ insert: [{ id: 'greeter', name: 'dsh-plugin-greeter' }] }],
});

try {
	// 3. The plugin activated: its tool is registered, and executing it through
	// the harness pipeline emits tools/result and returns the rendered content.
	const tools = ctx.get('tools');
	assert.ok(tools, 'tools service not mounted');

	let observed;
	ctx.on('tools/result', (execution, result) => {
		observed = { name: execution.name, result };
	});

	const { CallId } = await import('@deepseek-ai/dsh-llm');
	const result = await tools.execute({
		callId: CallId('devai-acceptance-1'),
		name: 'greet',
		arguments: { name: 'DEV-AI' },
		signal: new AbortController().signal,
	});

	assert.deepEqual(result.content, [{ type: 'text', text: 'Hello, DEV-AI!' }]);
	assert.equal(observed?.name, 'greet', 'tools/result event not observed');

	console.log('devai-harness acceptance: third-party plugin dsh-plugin-greeter loaded unmodified; greet tool executed through ctx.tools ->', JSON.stringify(result.content));
} finally {
	await ctx.fiber.dispose();
}

process.exit(0);
