/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Static consistency check for the embedded DSH harness packaging
 * (`npm run devai-harness-check`). An rpm/deb cannot be built on every dev
 * machine, so this validates cheaply what the real build relies on:
 *
 *  1. the staged component layout (structure-only staging run) contains the
 *     bridge entry the agent host spawns, and only shipped files;
 *  2. the spawn path in `dshAgent.ts` and the packaging constants agree;
 *  3. the harness dependencies are exact-pinned (never ranges or dist-tags —
 *     upstream is a developer preview with announced breaking changes);
 *  4. the Linux packaging pipeline still ships the whole binary dir for every
 *     format, and the rpm spec's %files/provides rules cover the component.
 *
 * Exits 0 when consistent, 1 with a list of violations otherwise.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	DEVAI_HARNESS_BRIDGE_ENTRY,
	DEVAI_HARNESS_COMPONENT_ENTRIES,
	DEVAI_HARNESS_DIR,
	stageDevaiHarness,
} from './lib/devaiHarness.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const errors: string[] = [];

function check(condition: boolean, message: string): void {
	if (!condition) {
		errors.push(message);
	}
}

function read(relativePath: string): string {
	return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Structure-only staging: the component stages, contains the bridge entry
// (and the composition anchors), and ships no test material.
const stagedRoot = stageDevaiHarness(repoRoot, { platform: 'linux', arch: 'x64', skipInstall: true });
check(fs.existsSync(path.join(stagedRoot, DEVAI_HARNESS_BRIDGE_ENTRY)), `staged tree misses the bridge entry: ${DEVAI_HARNESS_BRIDGE_ENTRY}`);
check(fs.existsSync(path.join(stagedRoot, 'package-lock.json')), 'staged tree misses package-lock.json (the production install is lockfile-exact)');
check(fs.existsSync(path.join(stagedRoot, 'bundle', 'cordis.patch.yml')), 'staged tree misses the devai bundle patch');
check(fs.existsSync(path.join(stagedRoot, 'bridge', 'src', 'index.js')), 'staged tree misses the devai-bridge plugin');
check(fs.existsSync(path.join(stagedRoot, 'src', 'profile-presets.ts')), 'staged tree misses the profile presets');
check(!fs.existsSync(path.join(stagedRoot, 'test')), 'staged tree must not ship the test directory');
check(!fs.existsSync(path.join(stagedRoot, '.tmp-test-home')) && !fs.existsSync(path.join(stagedRoot, '.tmp-bridge-test-home')), 'staged tree must not ship throwaway test homes');

// Every shipped entry actually exists in the repo (a rename would otherwise
// only fail at packaging time).
for (const entry of DEVAI_HARNESS_COMPONENT_ENTRIES) {
	check(fs.existsSync(path.join(repoRoot, DEVAI_HARNESS_DIR, entry)), `component entry listed for shipping does not exist: ${DEVAI_HARNESS_DIR}/${entry}`);
}

// ---------------------------------------------------------------------------
// 2. The agent host spawns exactly what packaging stages: dshAgent.ts derives
// the root from 'devai-harness' under the app root and the entry from
// join(root, 'src', 'bridge-main.ts').
const dshAgentSource = read('src/vs/platform/agentHost/node/dsh/dshAgent.ts');
check(dshAgentSource.includes(`join(appRoot, '${DEVAI_HARNESS_DIR}')`), `dshAgent.ts no longer resolves the harness root as <appRoot>/${DEVAI_HARNESS_DIR}`);
const [entryDir, entryFile] = DEVAI_HARNESS_BRIDGE_ENTRY.split('/');
check(dshAgentSource.includes(`join(harnessRoot, '${entryDir}', '${entryFile}')`), `dshAgent.ts no longer spawns ${DEVAI_HARNESS_BRIDGE_ENTRY}`);

// ---------------------------------------------------------------------------
// 3. Exact pins only: every harness dependency is an exact version (or an
// in-tree file: package). Ranges or dist-tags would let the pinned dsh
// runtime drift underneath the compatibility claim.
const harnessManifest = JSON.parse(read(path.join(DEVAI_HARNESS_DIR, 'package.json'))) as { dependencies?: Record<string, string> };
for (const [dependency, version] of Object.entries(harnessManifest.dependencies ?? {})) {
	const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || version.startsWith('file:');
	check(exact, `harness dependency is not exact-pinned: ${dependency}@${version}`);
}

// ---------------------------------------------------------------------------
// 4. Packaging pipeline consistency: the desktop package task stages the
// harness on Linux, and every Linux format ships the whole binary dir (which
// is what carries resources/app/devai-harness into deb/rpm/snap/appimage).
const desktopGulpfile = read('build/gulpfile.vscode.ts');
check(desktopGulpfile.includes('stageDevaiHarness(root, { platform, arch })'), 'build/gulpfile.vscode.ts no longer stages the harness for Linux packaging');
const linuxGulpfile = read('build/gulpfile.vscode.linux.ts');
const wholesaleCopies = linuxGulpfile.match(/binaryDir \+ '\/\*\*\/\*'/g) ?? [];
check(wholesaleCopies.length >= 4, `expected deb/rpm/snap/appimage to each copy the whole binary dir; found ${wholesaleCopies.length} wholesale copies`);

const rpmSpec = read('resources/linux/rpm/code.spec.template');
check(rpmSpec.includes('cp -r usr/share/%{name}/* %{buildroot}%{_datadir}/%{name}'), 'rpm spec no longer installs the whole application dir');
check(/%files[\s\S]*%{_datadir}\/%{name}\//.test(rpmSpec), 'rpm spec %files no longer claims the whole application dir');
check(rpmSpec.includes('\\.(so|node)'), 'rpm spec provides-exclude no longer covers bundled .node addons');

// ---------------------------------------------------------------------------
if (errors.length > 0) {
	console.error(`devai-harness check FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
	for (const error of errors) {
		console.error(`  - ${error}`);
	}
	process.exit(1);
}
console.log('devai-harness check OK: staged layout, spawn-path cross-check, exact pins, and Linux packaging pipeline are consistent');
