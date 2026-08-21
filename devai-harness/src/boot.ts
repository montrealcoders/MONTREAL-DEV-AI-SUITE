/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Embedded boot of the DEV-AI Harness (DSH): composes the `devai` profile
 * with the same layered patch mechanism the dsh CLI uses — each bundle patch
 * in `dsh.profile.bundles` order, then the profile's own `cordis.patch.yml`,
 * then caller overlays — and boots the pinned dsh runtime headless in the
 * current process via `@deepseek-ai/dsh-app-boot`.
 *
 * The harness home is `$DSH_HOME` (else `~/.dsh`), exactly as in the dsh CLI;
 * an embedding caller sets `DSH_HOME` before importing so profile, sessions,
 * settings, and credentials stay inside the product's own data directory.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import {
	boot,
	healProfilesModuleFallback,
	initProfile,
	loadProfile,
	resolveProfileDir,
	type Profile,
} from '@deepseek-ai/dsh-app-boot';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/** Diagnostic prefix on boot failures, mirroring the dsh CLI's bin name. */
const NAME = 'devai-harness';

/** The product profile name. */
export const DEVAI_PROFILE = 'devai';

/**
 * The devai profile's bundle layer list: the pinned dsh core, then the
 * DEV-AI Suite product overrides. Auto-initialized on first use, like the
 * dsh CLI's shipped profile templates.
 */
export const DEVAI_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', 'devai-harness-bundle'];

/** Absolute path of this component's package.json — the installation anchor bundle resolution starts from. */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url));

/** Root config filename inside a profile directory (same contract as the dsh CLI). */
const PROFILE_ROOT_FILENAME = 'cordis.yml';

/**
 * The empty root entry list every profile tree patches over. Rewritten on
 * every boot for the same reason the dsh CLI rewrites it: the Loader's tree
 * write-back can bake composed rows into the file, which would duplicate
 * every bundle insert on the next boot.
 */
const PROFILE_ROOT_CONFIG = `# devai profile root - an empty entry list. The tree is composed as patch
# layers: each bundle in package.json's dsh.profile.bundles, then
# cordis.patch.yml. Edit cordis.patch.yml, not this file.
[]
`;

/**
 * Ensure the devai profile exists under the harness home and return it,
 * loaded: manifest and patch layers resolved, module fallback healed.
 * @param home the harness home; defaults to `$DSH_HOME` (else `~/.dsh`).
 * @returns the loaded profile.
 */
export function ensureDevaiProfile(home: string = resolveDshHome()): Profile {
	const dir = resolveProfileDir(DEVAI_PROFILE, home);
	if (!existsSync(join(dir, 'package.json'))) {
		initProfile(dir, DEVAI_PROFILE_BUNDLES);
	}
	healProfilesModuleFallback(INSTALL_ANCHOR, home);
	return loadProfile(NAME, DEVAI_PROFILE, INSTALL_ANCHOR, home);
}

/** Options for {@link bootDevaiHarness}. */
export interface BootDevaiHarnessOptions {
	/** The harness home; defaults to `$DSH_HOME` (else `~/.dsh`). */
	home?: string;
	/** Patch layers applied after the profile's own `cordis.patch.yml` (the `--patch` slot of the dsh CLI). */
	overlays?: PatchOptions[];
}

/**
 * Boot the embedded harness on the devai profile and return the settled root
 * context. `boot()` itself asserts every enabled entry loaded and activated,
 * so a resolved return means the whole composed tree is running.
 * @param options harness home and overlay patch layers.
 * @returns the booted root context; dispose it via `ctx.fiber.dispose()`.
 */
export async function bootDevaiHarness(options: BootDevaiHarnessOptions = {}): Promise<Context> {
	const profile = ensureDevaiProfile(options.home);
	const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME);
	writeFileSync(rootConfig, PROFILE_ROOT_CONFIG);
	const patches = structuredClone([
		...profile.layers.flatMap(layer => layer.patches),
		...profile.patches,
		...(options.overlays ?? []),
	]);
	return boot(NAME, rootConfig, patches);
}
