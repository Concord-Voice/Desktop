/**
 * Regression test for the no-raw-ipcMain rule (plan Task 7A step 3): the main-scoped
 * `no-restricted-syntax` selector bans `ipcMain.handle|on|once|handleOnce` everywhere
 * except `src/main/ipc/registry.ts`, so every channel passes the admission registry.
 *
 * The virtual fixture path MUST be in eslint.config.mjs `allowDefaultProject`.
 */
import { ESLint } from 'eslint';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

async function lint(code: string, file: string) {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return result.messages;
}

const CODE = `
import { ipcMain } from 'electron';
ipcMain.handle('x', () => 1);
`;

describe('no-restricted-syntax: raw ipcMain registration in src/main', () => {
  it.each(['handle', 'on', 'once', 'handleOnce'])(
    'flags ipcMain.%s outside the registry',
    async (m) => {
      const messages = await lint(
        `import { ipcMain } from 'electron';\nipcMain.${m}('x', () => 1);\n`,
        'src/main/__ipc-lint-fixture__.ts'
      );
      expect(messages.filter((x) => x.fatal)).toEqual([]);
      expect(messages.filter((x) => x.ruleId === 'no-restricted-syntax')).toHaveLength(1);
    }
  );

  it('allows the same text inside src/main/ipc/registry.ts', async () => {
    const messages = await lint(CODE, 'src/main/ipc/registry.ts');
    expect(messages.filter((x) => x.fatal)).toEqual([]);
    expect(messages.filter((x) => x.ruleId === 'no-restricted-syntax')).toHaveLength(0);
  });
});
