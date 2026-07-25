// T4.1 step 4 — OpenCode leg. OpenCode auto-installs npm-named plugin
// entries listed in `opencode.json`'s `"plugin"` array at startup (verified
// in `packages/opencode-plugin/README.md` / `research/opencode.md`); no
// separate install command exists. This installer merges
// `"@dmemo/opencode-plugin"` into the GLOBAL config
// (`~/.config/opencode/opencode.json`, honoring `$XDG_CONFIG_HOME`) —
// idempotent (no duplicate entries on re-run), preserves every other key.

import fs from 'node:fs';
import path from 'node:path';
import { opencodeConfigDir, opencodeConfigPath } from '../hostDetect.js';

const PLUGIN_SPEC = '@dmemo/opencode-plugin';

export interface OpenCodeInstallResult {
  configPath: string;
  created: boolean;
  alreadyPresent: boolean;
}

export function installOpenCode(env: NodeJS.ProcessEnv = process.env): OpenCodeInstallResult {
  const dir = opencodeConfigDir(env);
  const configPath = opencodeConfigPath(env);
  fs.mkdirSync(dir, { recursive: true });

  let config: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
  let created = true;
  if (fs.existsSync(configPath)) {
    created = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object') config = parsed;
    } catch {
      throw new Error(
        `${configPath} exists but is not valid JSON — refusing to overwrite it. ` +
          `Add "${PLUGIN_SPEC}" to its "plugin" array manually.`
      );
    }
  }

  const pluginList: unknown = config.plugin;
  const existingList = Array.isArray(pluginList) ? (pluginList as unknown[]) : [];
  const alreadyPresent = existingList.some((p) => p === PLUGIN_SPEC);
  if (!alreadyPresent) {
    config.plugin = [...existingList, PLUGIN_SPEC];
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { configPath, created, alreadyPresent };
}
