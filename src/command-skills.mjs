/** Shared command identity for installation, discovery, health and packaging. */
export const ECONOMY_SKILL = Object.freeze({ name: 'offload_economy', profile: 'sonnet' });
export const PREMIUM_SKILL = Object.freeze({ name: 'offload_premium', profile: 'opus' });
export const COMMAND_SKILLS = Object.freeze([ECONOMY_SKILL, PREMIUM_SKILL]);
export const COMMAND_SKILL_NAMES = Object.freeze(COMMAND_SKILLS.map(({ name }) => name));
export const LEGACY_SKILL_NAMES = Object.freeze(['offload', 'offload_sonnet', 'offload_opus']);
export const PLUGIN_FILES = Object.freeze([
  'plugin.json',
  '.codex-plugin/plugin.json',
  ...COMMAND_SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`),
]);
export const packagedSkillPath = (name) => `plugins/offload/skills/${name}/SKILL.md`;
