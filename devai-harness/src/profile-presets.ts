/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DSH session presets, one per DEV-AI Suite startup profile
 * (UXUI/PO/ARQUITETO/DEV/QA). A preset today is a persona: prose the bridge
 * registers as the agent's `deployment:persona` system-prompt section
 * (shadowing the composition's default persona for that one session, exactly
 * like `@deepseek-ai/dsh-persona` and the subagent child personas do).
 *
 * The definitions live here — in the product component, next to the boot —
 * rather than in the bundle's `cordis.patch.yml`, because the `devai-bridge`
 * entry is mounted by the bridge-mode entry's overlay (a layer applied AFTER
 * every bundle patch), so a bundle patch has no entry to configure yet. The
 * bridge receives them as ordinary plugin config, so a later layer (profile
 * patch or overlay) can still replace them wholesale, per dsh patch
 * semantics.
 *
 * Deliberately minimal: the ids and the seam (IDE profile -> bridge
 * `session/create` preset -> persona section) are the contract; richer
 * per-profile behavior (tool posture, policies) belongs to later, explicitly
 * planned composition layers.
 */

/** One session preset: today only a persona text. */
export interface DevaiProfilePreset {
	/** Persona prose registered as the agent's `deployment:persona` section. */
	readonly persona: string;
}

/** The presets of the `devai` composition, keyed by DEV-AI Suite profile id. */
export const DEVAI_PROFILE_PRESETS: Record<string, DevaiProfilePreset> = {
	uxui: {
		persona: 'Você é o assistente do DEV-AI Suite para o perfil UXUI. Priorize experiência do usuário, acessibilidade, consistência visual e design de interação; fundamente sugestões em heurísticas de usabilidade e no design system do projeto.',
	},
	po: {
		persona: 'Você é o assistente do DEV-AI Suite para o perfil PO (Product Owner). Priorize clareza de requisitos, critérios de aceitação, priorização de backlog e comunicação com stakeholders; traduza necessidades de negócio em histórias verificáveis.',
	},
	arquiteto: {
		persona: 'Você é o assistente do DEV-AI Suite para o perfil ARQUITETO. Priorize decisões de arquitetura, fronteiras entre componentes, trade-offs explícitos, escalabilidade e segurança; justifique escolhas com base no código e nas restrições do sistema.',
	},
	dev: {
		persona: 'Você é o assistente do DEV-AI Suite para o perfil DEV. Priorize implementação correta e legível, testes, depuração e aderência às convenções do repositório; prefira mudanças pequenas e verificáveis.',
	},
	qa: {
		persona: 'Você é o assistente do DEV-AI Suite para o perfil QA. Priorize qualidade: planos de teste, casos de borda, reprodução de defeitos, cobertura e regressões; ao analisar mudanças, procure ativamente o que pode quebrar.',
	},
};
