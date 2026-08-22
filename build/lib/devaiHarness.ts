/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Packaging support for the `devai-harness/` component (the embedded DSH
 * runtime the agent host's DSH provider spawns).
 *
 * The component ships inside the built app at `resources/app/devai-harness`
 * — the exact location `resolveDshHarnessRoot` (dshAgent.ts) resolves when
 * `VSCODE_AGENT_HOST_DSH_HARNESS_ROOT` is not set — so every Linux package
 * format (deb/rpm/snap/appimage), which copies the whole
 * `VSCode-linux-<arch>` tree, picks it up without per-format file lists.
 *
 * Staging = copy the component's shipped files + a production
 * `npm ci --omit=dev` into `.build/devai-harness/<platform>-<arch>`; the
 * package task then streams the staged tree into the app. Installing (rather
 * than copying the dev checkout's node_modules) keeps the payload production
 * -only, lockfile-exact, and lets `--cpu`/`--os` select the target
 * platform's prebuilt native packages on cross-arch builds.
 */

/** The component directory name, both in-repo and inside `resources/app`. */
export const DEVAI_HARNESS_DIR = 'devai-harness';

/**
 * Top-level component entries that ship. Tests, throwaway test homes, and the
 * dev checkout's node_modules stay behind; node_modules is produced by the
 * staging install instead.
 */
export const DEVAI_HARNESS_COMPONENT_ENTRIES = [
	'package.json',
	'package-lock.json',
	'README.md',
	'bridge',
	'bundle',
	'src',
] as const;

/**
 * The bridge-mode boot entry, relative to the component root. Must stay in
 * sync with `dshHarnessBridgeEntry` in
 * `src/vs/platform/agentHost/node/dsh/dshAgent.ts` — that is the file the
 * agent host spawns; `build/checkDevaiHarness.ts` cross-checks the two.
 */
export const DEVAI_HARNESS_BRIDGE_ENTRY = 'src/bridge-main.ts';

/** Map a VS Code build arch onto npm's `--cpu` value (Node `process.arch`). */
function toNpmCpu(arch: string): string {
	return arch === 'armhf' ? 'arm' : arch;
}

export interface IStageDevaiHarnessOptions {
	/** VS Code build platform (only `linux` is wired into packaging today). */
	readonly platform: string;
	/** VS Code build arch (`x64` | `arm64` | `armhf`). */
	readonly arch: string;
	/** Skip the production npm install (structure-only staging, used by the consistency check). */
	readonly skipInstall?: boolean;
}

/** The staging base directory for a platform/arch (the gulp.src base). */
export function getDevaiHarnessStagingBase(repoRoot: string, platform: string, arch: string): string {
	return path.join(repoRoot, '.build', DEVAI_HARNESS_DIR, `${platform}-${arch}`);
}

/**
 * Stage the harness component for packaging: copy the shipped files into
 * `<stagingBase>/devai-harness` and run a production, lockfile-exact,
 * scripts-off npm install for the target platform/arch. `npm ci` reproduces
 * the lockfile's layout, which records the `file:` workspace packages
 * (`devai-bridge`, `devai-harness-bundle`) as symlinks — those are
 * dereferenced into real directories afterwards, so the staged tree survives
 * archive/stream pipelines that do not follow links. Returns the staged
 * component root.
 */
export function stageDevaiHarness(repoRoot: string, options: IStageDevaiHarnessOptions): string {
	const componentRoot = path.join(repoRoot, DEVAI_HARNESS_DIR);
	const stagingBase = getDevaiHarnessStagingBase(repoRoot, options.platform, options.arch);
	const stagedRoot = path.join(stagingBase, DEVAI_HARNESS_DIR);

	fs.rmSync(stagedRoot, { recursive: true, force: true });
	fs.mkdirSync(stagedRoot, { recursive: true });
	for (const entry of DEVAI_HARNESS_COMPONENT_ENTRIES) {
		const source = path.join(componentRoot, entry);
		if (!fs.existsSync(source)) {
			throw new Error(`[devai-harness] component entry missing: ${source}`);
		}
		fs.cpSync(source, path.join(stagedRoot, entry), { recursive: true });
	}
	const bridgeEntry = path.join(stagedRoot, DEVAI_HARNESS_BRIDGE_ENTRY);
	if (!fs.existsSync(bridgeEntry)) {
		throw new Error(`[devai-harness] staged tree is missing the bridge entry the agent host spawns: ${bridgeEntry}`);
	}

	if (!options.skipInstall) {
		execFileSync('npm', [
			'ci',
			'--omit=dev',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			`--os=${options.platform}`,
			`--cpu=${toNpmCpu(options.arch)}`,
		], { cwd: stagedRoot, stdio: 'inherit' });
		if (!fs.existsSync(path.join(stagedRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'))) {
			throw new Error('[devai-harness] production install did not materialize the pinned dsh runtime');
		}
		dereferenceWorkspaceLinks(path.join(stagedRoot, 'node_modules'));
	}

	return stagedRoot;
}

/**
 * Replace symlinked packages under `node_modules` (npm's layout for `file:`
 * dependencies) with real copies of their targets, so the staged tree needs
 * no symlink support downstream. Only in-tree targets are expected; an
 * escape outside the staged component would be a build bug and fails loud.
 */
function dereferenceWorkspaceLinks(nodeModules: string): void {
	for (const entry of fs.readdirSync(nodeModules)) {
		const linkPath = path.join(nodeModules, entry);
		if (!fs.lstatSync(linkPath).isSymbolicLink()) {
			continue;
		}
		const target = fs.realpathSync(linkPath);
		const componentRoot = path.dirname(nodeModules);
		if (!target.startsWith(componentRoot + path.sep)) {
			throw new Error(`[devai-harness] refusing to dereference ${linkPath}: target ${target} escapes the staged component`);
		}
		fs.rmSync(linkPath);
		fs.cpSync(target, linkPath, { recursive: true });
	}
}
