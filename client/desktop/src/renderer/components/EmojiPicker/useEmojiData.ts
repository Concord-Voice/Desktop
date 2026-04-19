import { useState, useEffect, useCallback } from 'react';
import { EmojiEntry, EmojiCategory } from './types';
import {
  getCachedCategory,
  setCachedCategory,
  isCategoryCached,
  getCategoriesMeta,
  setCategoriesMeta,
  getAllCachedCategories,
} from './emojiDataCache';

// Eager import for categories metadata (tiny file, always needed)
import categoriesMeta from '../../data/emoji/categories.json';

// Define lazy importers at module scope so Vite can statically analyze them.
// Each arrow function returns a dynamic import() that Vite will code-split.
const categoryLoaders: Record<string, () => Promise<{ default: EmojiEntry[] }>> = {
  smileys: () => import('../../data/emoji/smileys.json'),
  people: () => import('../../data/emoji/people.json'),
  animals: () => import('../../data/emoji/animals.json'),
  food: () => import('../../data/emoji/food.json'),
  travel: () => import('../../data/emoji/travel.json'),
  activities: () => import('../../data/emoji/activities.json'),
  objects: () => import('../../data/emoji/objects.json'),
  symbols: () => import('../../data/emoji/symbols.json'),
  flags: () => import('../../data/emoji/flags.json'),
};

export function useEmojiData() {
  const [categories, setCategories] = useState<EmojiCategory[]>(
    () => getCategoriesMeta() || categoriesMeta
  );
  const [loadedCategories, setLoadedCategories] = useState<Set<string>>(
    () => new Set(getAllCachedCategories().keys())
  );
  const [loadingCategory, setLoadingCategory] = useState<string | null>(null);

  // Store categories metadata on first mount
  useEffect(() => {
    if (!getCategoriesMeta()) {
      setCategoriesMeta(categoriesMeta);
    }
    setCategories(categoriesMeta);
  }, []);

  // Load a specific category's emoji data
  const loadCategory = useCallback(async (categoryId: string): Promise<EmojiEntry[]> => {
    // Return cached if available
    const cached = getCachedCategory(categoryId);
    if (cached) return cached;

    const loader = categoryLoaders[categoryId];
    if (!loader) return [];

    setLoadingCategory(categoryId);
    try {
      const mod = await loader();
      const data: EmojiEntry[] = mod.default;
      setCachedCategory(categoryId, data);
      setLoadedCategories((prev) => new Set(prev).add(categoryId));
      return data;
    } catch (err) {
      console.error(`Failed to load emoji category: ${categoryId}`, err);
      return [];
    } finally {
      setLoadingCategory(null);
    }
  }, []);

  // Get emoji data for a category (returns cached or empty)
  const getCategory = useCallback((categoryId: string): EmojiEntry[] => {
    return getCachedCategory(categoryId) || [];
  }, []);

  // Search across all loaded categories
  const search = useCallback(
    (query: string): EmojiEntry[] => {
      if (!query.trim()) return [];
      const lower = query.toLowerCase();
      const results: EmojiEntry[] = [];
      const cache = getAllCachedCategories();

      for (const [, emojis] of cache) {
        for (const emoji of emojis) {
          if (emoji.n.toLowerCase().includes(lower)) {
            results.push(emoji);
          }
        }
      }
      return results;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The search closure reads `categories` (imported module constant, stable) and `lower`/`results` (local); only `loadedCategories` should trigger re-memoization when a new category batch loads. Including the other values would invalidate the callback on every keystroke.
    [loadedCategories] // Re-create when new categories are loaded
  );

  // Load all categories for comprehensive search
  const loadAllForSearch = useCallback(async () => {
    if (!categories.length) return;
    const unloaded = categories.filter((c) => !isCategoryCached(c.id));
    await Promise.all(unloaded.map((c) => loadCategory(c.id)));
  }, [categories, loadCategory]);

  return {
    categories,
    loadedCategories,
    loadingCategory,
    loadCategory,
    getCategory,
    search,
    loadAllForSearch,
  };
}
