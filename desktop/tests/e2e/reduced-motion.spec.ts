import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import cases from './reduced-motion-cases.json';

// Each supplied S9440 identity remains a separate test. Use Chromium's cascade,
// including the real slider's UA shadow tree; jsdom cannot prove this contract.
for (const finding of cases) {
  test(`${finding.id}: ${finding.selector}`, { tag: '@renderer-only' }, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-reduce-animations', 'false');
    await page.addStyleTag({ content: readFileSync(finding.path, 'utf8') });
    const selectors = finding.selector.split(',').map((s) => s.trim());
    for (const selector of selectors) {
      const pseudo = selector.includes('::before') ? '::before' : null;
      const thumb = selector.includes('::-webkit-slider-thumb');
      const target = await page.evaluate((sel) => {
        const host = document.createElement('section');
        document.body.append(host);
        let parent: Element = host;
        for (const part of sel.replace(/::[\w-]+/g, '').split(/\s+/)) {
          const tag =
            part.match(/^[a-z]+/i)?.[0] ?? (sel.includes('slider-thumb') ? 'input' : 'div');
          const el =
            tag === 'svg'
              ? document.createElementNS('http://www.w3.org/2000/svg', tag)
              : document.createElement(tag);
          if (el instanceof HTMLInputElement) el.type = 'range';
          el.setAttribute('class', [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]).join(' '));
          parent.append(el);
          parent = el;
        }
        parent.id = 'motion-target';
        return parent.id;
      }, selector);
      const scroll = finding.selector === '.server-bar-scroll';
      const property = scroll
        ? 'scroll-behavior'
        : /transition/.test(
              readFileSync(finding.path, 'utf8')
                .split('\n')
                .slice(finding.line - 1, finding.line + 2)
                .join('\n')
            )
          ? 'transition-duration'
          : 'animation-duration';
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const value = async () => {
        if (!thumb)
          return page.evaluate(
            ({ id, property, pseudo }) =>
              getComputedStyle(document.getElementById(id)!, pseudo).getPropertyValue(property),
            { id: target, property, pseudo }
          );
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const find = (node: typeof root): number | undefined => {
          if (node.attributes?.includes('thumb')) return node.nodeId;
          for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
            const id = find(child);
            if (id) return id;
          }
        };
        const nodeId = find(root);
        expect(nodeId, 'real Chromium slider thumb').toBeTruthy();
        const computed = await cdp.send('CSS.getComputedStyleForNode', { nodeId: nodeId! });
        return computed.computedStyle.find((v) => v.name === property)!.value;
      };
      const normal = await value();
      expect(
        scroll ? normal === 'smooth' : normal.split(',').some((v) => parseFloat(v) > 0),
        'positive control: original motion is active'
      ).toBe(true);
      // Exercise the actual settings subscriber and its OS-preference listener.
      const setPreference = async (enabled: boolean) =>
        page.evaluate(async (enabled) => {
          const path = '/src/renderer/stores/ui/settingsStore.ts';
          const { useSettingsStore } = await import(/* @vite-ignore */ path);
          useSettingsStore.getState().setReduceAnimations(enabled);
        }, enabled);
      await setPreference(true);
      await expect.poll(value).toBe(scroll ? 'auto' : '0s');
      await setPreference(false);
      expect(await value()).toBe(normal);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.locator('html')).toHaveAttribute('data-reduce-animations', 'true');
      await expect.poll(value).toBe(scroll ? 'auto' : '0s');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(page.locator('html')).toHaveAttribute('data-reduce-animations', 'false');
      expect(await value()).toBe(normal);
      await page.locator('#motion-target').evaluate((el) => el.closest('section')!.remove());
      await cdp.detach();
    }
  });
}
