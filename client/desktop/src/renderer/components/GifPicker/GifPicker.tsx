import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Save, X, Search } from 'lucide-react';
import { gifProvider, type GifResolved, type GifCategory } from '../../services/gifProvider';
import { useSavedGifsStore } from '../../stores/savedGifsStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePrivacyStore } from '../../stores/privacyStore';
import './GifPicker.css';

interface GifPickerProps {
  onSelect: (slug: string) => void;
  onClose: () => void;
  position: { x: number; y: number };
}

type Tab = 'trending' | 'recent' | 'categories' | 'saved';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/** Render the animated rendition (video or image) for a GIF, with reduce-motion fallback. */
function GifMedia({ gif, reduceMotion }: Readonly<{ gif: GifResolved; reduceMotion: boolean }>) {
  if (reduceMotion) {
    return <img src={gif.stillUrl} alt="" draggable={false} />;
  }
  if (gif.animatedKind === 'video') {
    return (
      <video
        src={gif.animatedUrl}
        poster={gif.stillUrl}
        autoPlay
        loop
        muted
        playsInline
        tabIndex={-1}
      />
    );
  }
  return <img src={gif.animatedUrl} alt="" draggable={false} />;
}

/** Save / unsave button rendered on hover over each GIF tile. */
function SaveOverlayButton({ slug }: Readonly<{ slug: string }>) {
  const isSaved = useSavedGifsStore((s) => s.isGifSaved(slug));
  const saveGif = useSavedGifsStore((s) => s.saveGif);
  const removeGif = useSavedGifsStore((s) => s.removeGif);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSaved) {
      removeGif(slug);
    } else {
      saveGif(slug);
    }
  };

  return (
    <button
      className={`gif-save-overlay ${isSaved ? 'saved' : ''}`}
      onClick={handleClick}
      aria-label={isSaved ? 'Remove from saved' : 'Save GIF'}
      title={isSaved ? 'Remove from saved' : 'Save GIF'}
    >
      <Save size={16} />
    </button>
  );
}

/** Individual GIF tile with autoplay video / fallback image and the save overlay. */
function GifTile({
  gif,
  reduceMotion,
  onClick,
}: Readonly<{ gif: GifResolved; reduceMotion: boolean; onClick: () => void }>) {
  return (
    <button
      className="gif-tile"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      aria-label="Send GIF"
    >
      <GifMedia gif={gif} reduceMotion={reduceMotion} />
      <SaveOverlayButton slug={gif.slug} />
    </button>
  );
}

/** Category tile — clicking it switches the picker into search mode for that category. */
function CategoryTile({
  category,
  reduceMotion,
  onClick,
}: Readonly<{ category: GifCategory; reduceMotion: boolean; onClick: () => void }>) {
  return (
    <button
      className="gif-tile gif-category-tile"
      onClick={onClick}
      aria-label={`Browse ${category.name}`}
    >
      <GifMedia gif={category.preview} reduceMotion={reduceMotion} />
      <span className="gif-category-name">{category.name}</span>
    </button>
  );
}

/** Empty state shown when a tab has no content. */
function EmptyState({ message }: Readonly<{ message: string }>) {
  return <div className="gif-picker-empty">{message}</div>;
}

/** Render the body of the picker — depends on active tab + search state. */
function PickerBody({
  loading,
  error,
  isSearching,
  debouncedSearchTerm,
  activeTab,
  items,
  categories,
  reduceMotion,
  onGifClick,
  onCategoryClick,
}: Readonly<{
  loading: boolean;
  error: string | null;
  isSearching: boolean;
  debouncedSearchTerm: string;
  activeTab: Tab;
  items: GifResolved[];
  categories: GifCategory[];
  reduceMotion: boolean;
  onGifClick: (gif: GifResolved) => void;
  onCategoryClick: (name: string) => void;
}>) {
  if (loading) return <div className="gif-picker-loading">Loading…</div>;
  if (error) return <EmptyState message={error} />;

  if (activeTab === 'categories' && !isSearching) {
    if (categories.length === 0) return <EmptyState message="No categories available" />;
    return (
      <div className="gif-picker-grid">
        {categories.map((cat) => (
          <CategoryTile
            key={cat.name}
            category={cat}
            reduceMotion={reduceMotion}
            onClick={() => onCategoryClick(cat.name)}
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    let msg = 'No GIFs';
    if (isSearching) msg = `No GIFs found for "${debouncedSearchTerm}"`;
    else if (activeTab === 'saved') msg = 'No saved GIFs yet';
    else if (activeTab === 'recent') msg = 'No recent GIFs';
    else if (activeTab === 'trending') msg = 'No trending GIFs';
    return <EmptyState message={msg} />;
  }

  return (
    <div className="gif-picker-grid">
      {items.map((gif) => (
        <GifTile
          key={gif.slug}
          gif={gif}
          reduceMotion={reduceMotion}
          onClick={() => onGifClick(gif)}
        />
      ))}
    </div>
  );
}

/** Main GIF picker. Renders four tabs (Trending, Recent, Categories, Saved) plus
 *  a search input that overrides the active tab when text is present. The picker
 *  is rendered in a `<dialog>` element for accessibility. */
const GifPicker: React.FC<GifPickerProps> = ({ onSelect, onClose, position }) => {
  const reduceAnimations = useSettingsStore((s) => s.appearance.reduceAnimations);
  const savedGifSlugs = useSavedGifsStore((s) => s.gifs);
  const sharePersonalization = usePrivacyStore(
    (s) => s.settings.sharePersonalizationWithGifProvider
  );

  const [activeTab, setActiveTab] = useState<Tab>('trending');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [items, setItems] = useState<GifResolved[]>([]);
  const [categories, setCategories] = useState<GifCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickerRef = useRef<HTMLDialogElement>(null);

  // Debounce search term
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchTerm(searchTerm.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const isSearching = debouncedSearchTerm.length > 0;

  // Fetch content based on active tab + search state
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);

    const finish = (gifs: GifResolved[]) => {
      if (!cancelled) {
        setItems(gifs);
        setLoading(false);
      }
    };
    const fail = (msg: string) => {
      if (!cancelled) {
        setError(msg);
        setLoading(false);
      }
    };

    if (isSearching) {
      gifProvider
        .search({ q: debouncedSearchTerm, offset: 0, limit: PAGE_SIZE })
        .then((r) => finish(r.items))
        .catch(() => fail('Search failed'));
      return () => {
        cancelled = true;
      };
    }

    if (activeTab === 'trending') {
      gifProvider
        .trending({ offset: 0, limit: PAGE_SIZE })
        .then((r) => finish(r.items))
        .catch(() => fail('Failed to load trending GIFs'));
    } else if (activeTab === 'recent') {
      gifProvider
        .recent({ offset: 0, limit: PAGE_SIZE })
        .then((r) => finish(r.items))
        .catch(() => fail('Failed to load recent GIFs'));
    } else if (activeTab === 'categories') {
      gifProvider
        .categories({})
        .then((cats) => {
          if (!cancelled) {
            setCategories(cats);
            setItems([]);
            setLoading(false);
          }
        })
        .catch(() => fail('Failed to load categories'));
    } else if (activeTab === 'saved') {
      Promise.allSettled(savedGifSlugs.map((sg) => gifProvider.getBySlug(sg.slug)))
        .then((results) => {
          const gifs: GifResolved[] = [];
          for (const r of results) {
            if (r.status === 'fulfilled') gifs.push(r.value);
          }
          finish(gifs);
        })
        .catch(() => fail('Failed to load saved GIFs'));
    }

    return () => {
      cancelled = true;
    };
  }, [activeTab, isSearching, debouncedSearchTerm, savedGifSlugs]);

  const handleGifClick = useCallback(
    (gif: GifResolved) => {
      // Fire-and-forget the share trigger (best practice, optional per ToS)
      gifProvider.notifyShared?.(gif.slug).catch(() => {});
      onSelect(gif.slug);
      onClose();
    },
    [onSelect, onClose]
  );

  const handleCategoryClick = useCallback((name: string) => {
    setSearchTerm(name);
  }, []);

  // Click-outside-to-close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const visibleTabs = useMemo<Tab[]>(() => {
    const tabs: Tab[] = ['trending'];
    // Recent tab requires personalization (KLIPY's /recent endpoint needs customer_id).
    // When the user has disabled personalization, hide the tab entirely.
    if (gifProvider.supportsRecent && sharePersonalization) tabs.push('recent');
    if (gifProvider.supportsCategories) tabs.push('categories');
    tabs.push('saved');
    return tabs;
  }, [sharePersonalization]);

  const tabLabel = (tab: Tab): string => {
    switch (tab) {
      case 'trending':
        return 'Trending';
      case 'recent':
        return 'Recent';
      case 'categories':
        return 'Categories';
      case 'saved':
        return 'Saved';
    }
  };

  return (
    <dialog
      ref={pickerRef}
      open
      className={`gif-picker ${reduceAnimations ? 'reduce-motion' : ''}`}
      style={{ left: position.x, bottom: `calc(100% - ${position.y}px + 8px)` }}
      aria-label="GIF picker"
    >
      <div className="gif-picker-header">
        <div className="gif-picker-tabs">
          {visibleTabs.map((tab) => (
            <button
              key={tab}
              className={`gif-picker-tab ${activeTab === tab && !isSearching ? 'active' : ''}`}
              onClick={() => {
                setActiveTab(tab);
                setSearchTerm('');
              }}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </div>
        <button className="gif-picker-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="gif-picker-search">
        <Search size={14} className="gif-picker-search-icon" />
        <input
          type="text"
          placeholder={gifProvider.searchPlaceholder}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          autoFocus
          aria-label={gifProvider.searchPlaceholder}
        />
      </div>

      <div className="gif-picker-body">
        <PickerBody
          loading={loading}
          error={error}
          isSearching={isSearching}
          debouncedSearchTerm={debouncedSearchTerm}
          activeTab={activeTab}
          items={items}
          categories={categories}
          reduceMotion={reduceAnimations}
          onGifClick={handleGifClick}
          onCategoryClick={handleCategoryClick}
        />
      </div>

      <div className="gif-picker-footer">
        {gifProvider.logoAsset && (
          <img src={gifProvider.logoAsset} alt={gifProvider.name} className="gif-picker-logo" />
        )}
        <span className="gif-picker-attribution">{gifProvider.poweredByText}</span>
        {gifProvider.independenceDisclaimer && (
          <span className="gif-picker-disclaimer">{gifProvider.independenceDisclaimer}</span>
        )}
      </div>
    </dialog>
  );
};

export default GifPicker;
