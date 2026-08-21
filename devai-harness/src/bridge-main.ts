/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bridge-mode entry of the embedded DEV-AI Harness: boots the `devai`
 * profile with the `devai-bridge` plugin mounted through the overlay patch
 * slot (the dsh CLI's `--patch` layer), then serves bridge protocol v0 on
 * stdio until the client requests `shutdown` or closes stdin.
 *
 * The caller (the IDE's Agent Host, or the contract test) sets `DSH_HOME`
 * before spawning so sessions, settings, and credentials live inside the
 * product's data directory. Stdout carries only protocol frames; boot
 * diagnostics go to stderr.
 */

import { bootDevaiHarness } from './boot.ts';

const ctx = await bootDevaiHarness({
	overlays: [{ insert: [{ id: 'devai-bridge', name: 'devai-bridge' }] }],
});

let exiting = false;
/**
 * Dispose the root runtime once (flushing persistence) and exit.
 * @param code process exit code.
 */
function disposeAndExit(code: number): void {
	if (exiting) {
		return;
	}
	exiting = true;
	void ctx.fiber.dispose().finally(() => process.exit(code));
}

// The bridge plugin owns the `shutdown` method's flush-dispose-exit path;
// this entry owns EOF and signal exits, like the dsh app bin.
process.stdin.on('end', () => disposeAndExit(0));
process.on('SIGINT', () => disposeAndExit(0));
process.on('SIGTERM', () => disposeAndExit(0));
