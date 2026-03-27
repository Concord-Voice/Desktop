import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmojiEntry } from '@/renderer/components/EmojiPicker/types';

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Mock emojiDataCache so we can control what is cached without hitting real module state.
const mockCategoryMap = new Map<string, EmojiEntry[]>();
let mockCategoriesMeta: unknown = null;

vi.mock('@/renderer/components/EmojiPicker/emojiDataCache', () => ({
  getCachedCategory: (id: string) => mockCategoryMap.get(id),
  setCachedCategory: (id: string, data: EmojiEntry[]) => mockCategoryMap.set(id, data),
  isCategoryCached: (id: string) => mockCategoryMap.has(id),
  getCategoriesMeta: () => mockCategoriesMeta,
  setCategoriesMeta: (meta: unknown) => {
    mockCategoriesMeta = meta;
  },
  getAllCachedCategories: () => mockCategoryMap,
}));

// Mock the categories.json metadata file
vi.mock('@/renderer/data/emoji/categories.json', () => ({
  default: [
    { id: 'smileys', name: 'Smileys', icon: '😀', file: 'smileys.json', count: 2 },
    { id: 'people', name: 'People', icon: '👋', file: 'people.json', count: 1 },
  ],
}));

// Mock individual category JSON files
vi.mock('@/renderer/data/emoji/smileys.json', () => ({
  default: [
    { e: '😀', n: 'grinning face', s: false },
    { e: '😂', n: 'face with tears of joy', s: false },
  ] as EmojiEntry[],
}));

vi.mock('@/renderer/data/emoji/people.json', () => ({
  default: [{ e: '👋', n: 'waving hand', s: true }] as EmojiEntry[],
}));

// Stub remaining category files so dynamic imports don't fail
// Note: vi.mock() is hoisted, so loop variables are not available — list each explicitly
vi.mock('@/renderer/data/emoji/animals.json', () => ({ default: [] as EmojiEntry[] }));
vi.mock('@/renderer/data/emoji/food.json', () => ({ default: [] as EmojiEntry[] }));
vi.mock('@/renderer/data/emoji/travel.json', () => ({ default: [] as EmojiEntry[] }));
vi.mock('@/renderer/data/emoji/activities.json', () => ({ default: [] as EmojiEntry[] }));
vi.mock('@/renderer/data/emoji/objects.json', () => ({ default: [] as EmojiEntry[] }));
vi.mock('@/renderer/data/emoji/symbols.json', () => ({ default: [] as EmojiEntry[] }));
vi.mock('@/renderer/data/emoji/flags.json', () => ({ default: [] as EmojiEntry[] }));

// ─── Tests ───────────────────────────────────────────────────────────────────

// Import the hook AFTER mocks are set up
const { useEmojiData } = await import('@/renderer/components/EmojiPicker/useEmojiData');

beforeEach(() => {
  mockCategoryMap.clear();
  mockCategoriesMeta = null;
});

describe('useEmojiData — initial state', () => {
  it('returns categories from categoriesMeta on mount', async () => {
    const { result } = renderHook(() => useEmojiData());
    await waitFor(() => expect(result.current.categories.length).toBeGreaterThan(0));
    expect(result.current.categories[0].id).toBe('smileys');
  });

  it('loadingCategory is null initially', () => {
    const { result } = renderHook(() => useEmojiData());
    expect(result.current.loadingCategory).toBeNull();
  });
});

describe('useEmojiData — loadCategory', () => {
  it('returns cached data without re-importing', async () => {
    const cached: EmojiEntry[] = [{ e: '😀', n: 'grinning face', s: false }];
    mockCategoryMap.set('smileys', cached);

    const { result } = renderHook(() => useEmojiData());

    let returned: EmojiEntry[] = [];
    await act(async () => {
      returned = await result.current.loadCategory('smileys');
    });

    expect(returned).toBe(cached);
    // loadingCategory should still be null (cache hit skips the loading state)
    expect(result.current.loadingCategory).toBeNull();
  });

  it('dynamically imports and caches the category on a cache miss', async () => {
    const { result } = renderHook(() => useEmojiData());
    await waitFor(() => expect(result.current.categories.length).toBeGreaterThan(0));

    let returned: EmojiEntry[] = [];
    await act(async () => {
      returned = await result.current.loadCategory('smileys');
    });

    expect(returned.length).toBe(2);
    expect(returned[0].e).toBe('😀');
    expect(mockCategoryMap.has('smileys')).toBe(true);
  });

  it('returns empty array for an unknown categoryId', async () => {
    const { result } = renderHook(() => useEmojiData());

    let returned: EmojiEntry[] = [];
    await act(async () => {
      returned = await result.current.loadCategory('unknown-category');
    });

    expect(returned).toEqual([]);
  });
});

describe('useEmojiData — getCategory', () => {
  it('returns empty array when category is not cached', async () => {
    const { result } = renderHook(() => useEmojiData());
    expect(result.current.getCategory('animals')).toEqual([]);
  });

  it('returns cached data after loadCategory', async () => {
    const { result } = renderHook(() => useEmojiData());
    await waitFor(() => expect(result.current.categories.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.loadCategory('smileys');
    });

    expect(result.current.getCategory('smileys').length).toBe(2);
  });
});

describe('useEmojiData — search', () => {
  it('returns empty array for an empty query', async () => {
    const { result } = renderHook(() => useEmojiData());
    expect(result.current.search('')).toEqual([]);
    expect(result.current.search('   ')).toEqual([]);
  });

  it('returns matching emojis from the loaded cache', async () => {
    mockCategoryMap.set('smileys', [
      { e: '😀', n: 'grinning face', s: false },
      { e: '😂', n: 'face with tears of joy', s: false },
    ]);

    const { result } = renderHook(() => useEmojiData());

    const results = result.current.search('face');
    expect(results.length).toBe(2);
  });

  it('is case-insensitive', async () => {
    mockCategoryMap.set('smileys', [{ e: '😀', n: 'Grinning Face', s: false }]);

    const { result } = renderHook(() => useEmojiData());
    expect(result.current.search('grinning').length).toBe(1);
    expect(result.current.search('GRINNING').length).toBe(1);
  });

  it('returns empty array when no emoji matches', async () => {
    mockCategoryMap.set('smileys', [{ e: '😀', n: 'grinning face', s: false }]);
    const { result } = renderHook(() => useEmojiData());
    expect(result.current.search('zzznomatch')).toEqual([]);
  });
});

describe('useEmojiData — loadAllForSearch', () => {
  it('loads all uncached categories', async () => {
    const { result } = renderHook(() => useEmojiData());
    await waitFor(() => expect(result.current.categories.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.loadAllForSearch();
    });

    // smileys and people should now be cached
    expect(mockCategoryMap.has('smileys')).toBe(true);
    expect(mockCategoryMap.has('people')).toBe(true);
  });

  it('skips categories that are already cached', async () => {
    const existing: EmojiEntry[] = [{ e: '😀', n: 'cached', s: false }];
    mockCategoryMap.set('smileys', existing);

    const { result } = renderHook(() => useEmojiData());
    await waitFor(() => expect(result.current.categories.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.loadAllForSearch();
    });

    // Smileys was already cached — its reference should be unchanged
    expect(mockCategoryMap.get('smileys')).toBe(existing);
  });
});
