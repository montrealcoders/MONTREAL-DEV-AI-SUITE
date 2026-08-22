/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mapping between the DEV-AI Suite startup profile selection and the DSH
 * session presets of the embedded harness.
 *
 * The workbench persists the selected profile (UXUI/PO/ARQUITETO/DEV/QA,
 * `IProfileSelectionService`) under {@link DSH_SELECTED_PROFILE_STORAGE_KEY}
 * in application-scoped storage. The renderer-side agent host clients forward
 * that raw value to the agent host as root config
 * (`AgentHostDshSelectedProfileConfigKey`), and `DshAgent` maps it through
 * {@link dshSessionPresetForProfile} into the `preset` default of bridge
 * `session/create` calls. The preset definitions themselves (persona text per
 * profile) live in the harness component (`devai-harness/src/profile-presets.ts`)
 * and are validated by the bridge, so this module deliberately maps ids only.
 *
 * This constant lives in platform (not next to the workbench
 * `IProfileSelectionService` that owns the selection UX) because the platform
 * agent-host clients cannot import workbench code; the workbench service
 * re-exports it, keeping a single source of truth.
 */

/** Application-scope storage key holding the selected DEV-AI Suite profile id. */
export const DSH_SELECTED_PROFILE_STORAGE_KEY = 'devai.selectedProfile';

/**
 * The DSH session preset ids the embedded harness defines, one per DEV-AI
 * Suite startup profile. Must stay a superset of the workbench `ProfileId`
 * enum values — a profile without a preset silently falls back to the
 * composition's default (no persona override).
 */
export const DSH_SESSION_PRESET_IDS = ['uxui', 'po', 'arquiteto', 'dev', 'qa'] as const;

/** One of {@link DSH_SESSION_PRESET_IDS}. */
export type DshSessionPresetId = typeof DSH_SESSION_PRESET_IDS[number];

/**
 * Map a raw stored/forwarded profile value onto a DSH session preset id.
 * Anything that is not exactly a known preset id (unset, empty, an old or
 * future profile value, non-string garbage) maps to `undefined`, which means
 * "no preset": the session boots on the composition's defaults.
 */
export function dshSessionPresetForProfile(profile: unknown): DshSessionPresetId | undefined {
	return typeof profile === 'string' && (DSH_SESSION_PRESET_IDS as readonly string[]).includes(profile)
		? profile as DshSessionPresetId
		: undefined;
}
