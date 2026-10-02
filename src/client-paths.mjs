/** Resolve native client homes once so installer and doctor inspect the same files. */
import { join } from 'node:path';

export function resolveClientPaths({ home, env = process.env, platform = process.platform } = {}) {
  const userHome = home || (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || process.cwd();
  // Claude Code deliberately keeps the user MCP state alongside a custom
  // configuration directory. Its default remains the historical ~/.claude.json.
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(userHome, '.claude');
  const claudeState = env.CLAUDE_CONFIG_DIR ? join(claudeDir, '.claude.json') : join(userHome, '.claude.json');
  const codexDir = env.CODEX_HOME || join(userHome, '.codex');
  return {
    home: userHome,
    claudeDir,
    claudeState,
    claudeSettings: join(claudeDir, 'settings.json'),
    claudeMemory: join(claudeDir, 'CLAUDE.md'),
    claudeSkill: join(claudeDir, 'skills', 'offload', 'SKILL.md'),
    claudeLegacyCommand: join(claudeDir, 'commands', 'offload.md'),
    codexDir,
    codexConfig: join(codexDir, 'config.toml'),
    codexMemory: join(codexDir, 'AGENTS.md'),
    codexSkill: join(codexDir, 'skills', 'offload', 'SKILL.md'),
    cursorConfig: join(userHome, '.cursor', 'mcp.json'),
    cursorRule: join(userHome, '.cursor', 'rules', 'offload.md'),
  };
}
