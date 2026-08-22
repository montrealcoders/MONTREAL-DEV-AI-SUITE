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
 *     format, and the rpm spec's %files/provides rules cover the component;
 *  5. branding: "DeepSeek Harness" never names the product or a feature —
 *     it may appear only in descriptive text qualified by the pinned version
 *     or an explicit compatibility/pin statement (upstream BRAND_GUIDELINES
 *     items 7-9); the product/feature name is "DSH" / "DEV-AI Harness (DSH)";
 *  6. licensing: the MIT notice for the pinned runtime is present and every
 *     direct dsh-runtime dependency is registered in cgmanifest.json with
 *     the exact shipped version.
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

// The lockfile must stay peer-full: the pinned runtime's workspace packages
// declare each other as peer dependencies, so a lockfile regenerated under
// legacy-peer-deps (the repository root's .npmrc default, applied when npm
// runs with the repo root as its project) silently drops runtime-essential
// packages, and the staging `npm ci` would reproduce the broken tree. The
// root `devai-harness-test` script passes --no-legacy-peer-deps for the same
// reason.
check(read(path.join(DEVAI_HARNESS_DIR, 'package-lock.json')).includes('node_modules/@deepseek-ai/cordis-plugin-group'), 'devai-harness/package-lock.json lost its peer-installed runtime packages (regenerated under legacy-peer-deps?); reinstall with --no-legacy-peer-deps from inside devai-harness');

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
// 5. Branding: every "DeepSeek Harness" line must be descriptive — carrying
// the pinned version, an explicit compatibility claim, or a pin statement.
// Anything else reads as (or drifts into) naming the product after the
// upstream, which the upstream brand guidelines forbid.
const BRANDING_SCAN_ROOTS = ['src', 'devai-harness', 'build', 'resources', 'extensions'];
const BRANDING_SCAN_FILES = ['product.json', 'package.json', 'ThirdPartyNotices.txt', 'cgmanifest.json'];
const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.template', '.desktop', '.xml', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.build', 'out', 'out-build', 'out-vscode']);
const DESCRIPTIVE_LINE = /compatible with DeepSeek Harness|compat[íi]vel com (o )?DeepSeek Harness|DeepSeek Harness v0\.1\.1-rc\.2|pinned/i;

function* walkTextFiles(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.tmp-') || SKIP_DIRS.has(entry.name)) {
			continue;
		}
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTextFiles(full);
		} else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
			yield full;
		}
	}
}

const brandingFiles: string[] = [...BRANDING_SCAN_FILES.map(file => path.join(repoRoot, file))];
for (const scanRoot of BRANDING_SCAN_ROOTS) {
	const full = path.join(repoRoot, scanRoot);
	if (fs.existsSync(full)) {
		brandingFiles.push(...walkTextFiles(full));
	}
}
// This checker's own comments state the rule and would match themselves.
const selfPath = path.join(repoRoot, 'build', 'checkDevaiHarness.ts');
for (const file of brandingFiles.filter(candidate => candidate !== selfPath)) {
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes('DeepSeek Harness')) {
			continue;
		}
		const relative = path.relative(repoRoot, file);
		check(DESCRIPTIVE_LINE.test(line), `non-descriptive "DeepSeek Harness" use (name it "DSH" / "DEV-AI Harness (DSH)", or qualify with the pinned version): ${relative}:${i + 1}`);
		// User-facing strings additionally need the explicit compatibility claim.
		if (line.includes('localize(')) {
			check(/compatible with DeepSeek Harness v0\.1\.1-rc\.2/.test(line), `user-facing string mentions DeepSeek Harness without the versioned compatibility claim: ${relative}:${i + 1}`);
		}
	}
}

// The bridge README must state the pinned-version compatibility contract.
check(read(path.join(DEVAI_HARNESS_DIR, 'bridge', 'README.md')).includes('DeepSeek Harness v0.1.1-rc.2'), 'bridge/README.md no longer states the pinned-version compatibility claim');

// ---------------------------------------------------------------------------
// 6. Licensing: the MIT notice for the pinned runtime ships, and every direct
// dsh-runtime dependency is registered in cgmanifest.json at the exact
// shipped version.
const thirdPartyNotices = read('ThirdPartyNotices.txt');
check(thirdPartyNotices.includes('deepseek-ai/deepseek-harness 0.1.1-rc.2 - MIT'), 'ThirdPartyNotices.txt misses the pinned dsh runtime section');
check(thirdPartyNotices.includes('Copyright (c) 2026 DeepSeek'), 'ThirdPartyNotices.txt misses the DeepSeek MIT copyright line');

interface CgManifest { registrations: { component: { type: string; npm?: { name: string; version: string } } }[] }
const cgManifest = JSON.parse(read('cgmanifest.json')) as CgManifest;
const registeredNpm = new Map(cgManifest.registrations
	.filter(registration => registration.component.type === 'npm' && registration.component.npm)
	.map(registration => [registration.component.npm!.name, registration.component.npm!.version]));
for (const [dependency, version] of Object.entries(harnessManifest.dependencies ?? {})) {
	if (version.startsWith('file:')) {
		continue; // first-party workspace packages
	}
	check(registeredNpm.get(dependency) === version, `cgmanifest.json misses (or mis-versions) the harness dependency ${dependency}@${version}`);
}

// ---------------------------------------------------------------------------
if (errors.length > 0) {
	console.error(`devai-harness check FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
	for (const error of errors) {
		console.error(`  - ${error}`);
	}
	process.exit(1);
}
console.log('devai-harness check OK: staged layout, spawn-path cross-check, exact pins, Linux packaging pipeline, branding, and license registrations are consistent');
