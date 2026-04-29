import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '../../../test-utils';
import MarkdownContent from '@/renderer/components/Markdown/MarkdownContent';
import {
  indexCategory,
  resetShortcodeIndex,
} from '@/renderer/components/EmojiPicker/shortcodeIndex';
import { resetAllStores } from '../../../helpers/store-helpers';

const emptyLookup = { users: new Map(), roles: new Map() };
const userLookup = {
  users: new Map([['abc-123', 'alice']]),
  roles: new Map([['role-42', 'Admin']]),
};

function renderMd(content: string, lookup = emptyLookup) {
  return render(
    <MarkdownContent id="m1" content={content} editedAt={null} mentionLookup={lookup} />
  );
}

describe('MarkdownContent', () => {
  beforeEach(() => {
    resetAllStores();
    resetShortcodeIndex();
    indexCategory('smileys', [{ e: '😄', n: 'smile', s: false, c: ['smile'] }]);
  });

  describe('must-have rendering', () => {
    it('renders bold', () => {
      renderMd('**hello**');
      expect(screen.getByText('hello').tagName).toBe('STRONG');
    });

    it('renders italic', () => {
      renderMd('*hello*');
      expect(screen.getByText('hello').tagName).toBe('EM');
    });

    it('renders strikethrough', () => {
      renderMd('~~hello~~');
      expect(screen.getByText('hello').tagName).toBe('DEL');
    });

    it('renders inline code', () => {
      renderMd('`hello`');
      expect(screen.getByText('hello').tagName).toBe('CODE');
    });

    it('renders fenced code block', () => {
      renderMd('```\nhello\n```');
      const code = screen.getByText(/hello/);
      expect(code.closest('pre')).not.toBeNull();
    });

    it('preserves hljs classes on fenced code block with explicit language', () => {
      // End-to-end test for PR #711: rehype-highlight emits
      // `<code class="hljs language-js">` and inner `<span class="hljs-*">`
      // tokens; the sanitize schema must allow both the bare `hljs` theme
      // anchor on <code> AND the `hljs-*` token classes on <span>, or syntax
      // highlighting silently breaks at the sanitize layer.
      const { container } = renderMd('```js\nconst x = 42;\n```');
      const codeEl = container.querySelector('pre code');
      expect(codeEl).not.toBeNull();
      const className = codeEl?.getAttribute('class') ?? '';
      expect(className).toContain('hljs');
      expect(className).toContain('language-js');
      // Inner token spans must survive sanitize — at least one hljs-* class
      // should appear in the rendered subtree (keyword, number, string, ...).
      const tokenSpans = container.querySelectorAll('[class^="hljs-"]');
      expect(tokenSpans.length).toBeGreaterThan(0);
    });

    it('renders block quote', () => {
      renderMd('> hello');
      expect(screen.getByText('hello').closest('blockquote')).not.toBeNull();
    });

    it('renders unordered list', () => {
      renderMd('- a\n- b');
      expect(screen.getByText('a').closest('ul')).not.toBeNull();
    });

    it('renders ordered list', () => {
      renderMd('1. a\n2. b');
      expect(screen.getByText('a').closest('ol')).not.toBeNull();
    });

    it('renders explicit link via SafeLink', () => {
      renderMd('[hello](https://example.com)');
      const link = screen.getByText('hello');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'https://example.com');
    });

    it('renders autolinked URL', () => {
      renderMd('visit https://example.com today');
      const link = screen.getByText('https://example.com');
      expect(link.tagName).toBe('A');
    });

    it('renders paragraphs', () => {
      renderMd('first\n\nsecond');
      expect(screen.getByText('first').tagName).toBe('P');
      expect(screen.getByText('second').tagName).toBe('P');
    });
  });

  describe('should-have rendering', () => {
    it('renders spoiler as click-to-reveal', () => {
      renderMd('||secret||');
      const el = screen.getByText('secret');
      expect(el).toHaveClass('spoiler');
      fireEvent.click(el);
      expect(el).toHaveClass('spoiler-revealed');
    });

    it('renders headers h1/h2/h3', () => {
      renderMd('# One\n## Two\n### Three');
      expect(screen.getByText('One').tagName).toBe('H1');
      expect(screen.getByText('Two').tagName).toBe('H2');
      expect(screen.getByText('Three').tagName).toBe('H3');
    });

    it('renders horizontal rule', () => {
      const { container } = renderMd('---');
      expect(container.querySelector('hr')).not.toBeNull();
    });

    it('substitutes :smile: with 😄', () => {
      renderMd('hi :smile:');
      expect(screen.getByText(/😄/)).toBeInTheDocument();
    });
  });

  describe('mentions', () => {
    it('renders <@userId> as resolved display name', () => {
      renderMd('hey <@abc-123>', userLookup);
      expect(screen.getByText('@alice')).toBeInTheDocument();
    });

    it('renders <@&roleId> as role name', () => {
      renderMd('attention <@&role-42>', userLookup);
      expect(screen.getByText('@Admin')).toBeInTheDocument();
    });
  });

  describe('safety', () => {
    it('strips script tags', () => {
      const { container } = renderMd('hello <script>alert(1)</script>');
      expect(container.querySelector('script')).toBeNull();
    });

    it('strips img tags', () => {
      const { container } = renderMd('![alt](http://x/x.png)');
      expect(container.querySelector('img')).toBeNull();
    });

    it('strips javascript: links', () => {
      const { container } = renderMd('[x](javascript:alert(1))');
      const anchors = container.querySelectorAll('a');
      anchors.forEach((a) => {
        expect(a.getAttribute('href') || '').not.toContain('javascript:');
      });
    });
  });
});
