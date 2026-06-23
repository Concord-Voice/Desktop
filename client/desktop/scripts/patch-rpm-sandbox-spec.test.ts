// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  RPM_APP_DIR_LINE,
  RPM_SANDBOX_ATTR_LINE,
  patchRpmSpecTemplateSource,
} from './patch-rpm-sandbox-spec.mjs';

describe('patchRpmSpecTemplateSource', () => {
  it('pins chrome-sandbox SUID metadata in the RPM files manifest', () => {
    const source = `%files\n/usr/bin/<%= name %>\n${RPM_APP_DIR_LINE}\n/usr/share/applications/<%= name %>.desktop\n`;

    const result = patchRpmSpecTemplateSource(source);

    expect(result.changed).toBe(true);
    expect(result.source).toContain(`${RPM_APP_DIR_LINE}\n${RPM_SANDBOX_ATTR_LINE}\n`);
  });

  it('is idempotent when the RPM sandbox attr is already present', () => {
    const source = `%files\n${RPM_APP_DIR_LINE}\n${RPM_SANDBOX_ATTR_LINE}\n`;

    const result = patchRpmSpecTemplateSource(source);

    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
  });

  it('fails loudly when the upstream spec shape changes', () => {
    expect(() => patchRpmSpecTemplateSource('%files\n/usr/bin/<%= name %>\n')).toThrow(
      RPM_APP_DIR_LINE
    );
  });
});
