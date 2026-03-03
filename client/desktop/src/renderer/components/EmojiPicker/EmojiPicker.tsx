import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { EmojiPickerProps, EmojiEntry, SkinTone, SKIN_TONES } from './types';
import { useEmojiData } from './useEmojiData';
import {
  getRecentEmojis,
  addRecentEmoji,
  getSavedSkinTone,
  saveSkinTone,
} from './emojiDataCache';
import EmojiSearch from './EmojiSearch';
import EmojiCategoryBar from './EmojiCategoryBar';
import EmojiGrid from './EmojiGrid';
import './EmojiPicker.css';

const EmojiPicker: React.FC<EmojiPickerProps> = ({
  onSelect,
  onClose,
  mode = 'popover',
  position,
}) => {
  const {
    categories,
    loadingCategory,
    loadCategory,
    getCategory,
    search,
    loadAllForSearch,
  } = useEmojiData();

  const recentEmojis = getRecentEmojis();
  const hasRecent = recentEmojis.length > 0;

  const [activeCategory, setActiveCategory] = useState<string>(
    hasRecent ? 'recent' : 'smileys'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EmojiEntry[]>([]);
  const [hoveredEmoji, setHoveredEmoji] = useState<EmojiEntry | null>(null);
  const [skinTone, setSkinTone] = useState<SkinTone>(
    () => getSavedSkinTone() as SkinTone
  );
  const [showSkinTones, setShowSkinTones] = useState(false);

  const pickerRef = useRef<HTMLDivElement>(null);
  const initialLoadDone = useRef(false);

  // Load initial category on mount
  useEffect(() => {
    if (categories.length > 0 && !initialLoadDone.current) {
      initialLoadDone.current = true;
      loadCategory('smileys');
    }
  }, [categories, loadCategory]);

  // Load category when tab changes
  useEffect(() => {
    if (activeCategory && activeCategory !== 'recent') {
      loadCategory(activeCategory);
    }
  }, [activeCategory, loadCategory]);

  // Handle search
  useEffect(() => {
    if (searchQuery.trim()) {
      const results = search(searchQuery);
      setSearchResults(results);
      // If searching and not all categories loaded, load them
      loadAllForSearch();
    } else {
      setSearchResults([]);
    }
  }, [searchQuery, search, loadAllForSearch]);

  // Close on outside click (popover mode only)
  useEffect(() => {
    if (mode !== 'popover') return;

    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Delay adding click listener to avoid immediate close from the opening click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    document.addEventListener('keydown', handleEscape);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [mode, onClose]);

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      addRecentEmoji(emoji);
      onSelect(emoji);
    },
    [onSelect]
  );

  const handleCategorySelect = useCallback((categoryId: string) => {
    setActiveCategory(categoryId);
    setSearchQuery('');
  }, []);

  const handleSkinToneChange = useCallback((tone: SkinTone) => {
    setSkinTone(tone);
    saveSkinTone(tone);
    setShowSkinTones(false);
  }, []);

  // Get current display emojis
  const getDisplayEmojis = (): EmojiEntry[] => {
    if (searchQuery.trim()) {
      return searchResults;
    }
    if (activeCategory === 'recent') {
      return recentEmojis.map((e) => ({
        e,
        n: 'recently used',
        s: false,
      }));
    }
    return getCategory(activeCategory);
  };

  const displayEmojis = getDisplayEmojis();
  const isLoading = loadingCategory === activeCategory;

  const pickerContent = (
    <div
      ref={pickerRef}
      className={`emoji-picker ${mode === 'popover' ? 'emoji-picker--popover' : 'emoji-picker--inline'}`}
      style={
        mode === 'popover' && position
          ? { left: position.x, top: position.y }
          : undefined
      }
    >
      <EmojiSearch
        onSearch={setSearchQuery}
        autoFocus={mode === 'popover'}
      />

      {!searchQuery && (
        <EmojiCategoryBar
          categories={categories}
          activeCategory={activeCategory}
          hasRecent={hasRecent}
          onSelect={handleCategorySelect}
        />
      )}

      <EmojiGrid
        emojis={displayEmojis}
        onSelect={handleEmojiSelect}
        skinTone={skinTone}
        isLoading={isLoading}
        onHover={setHoveredEmoji}
      />

      <div className="emoji-picker-footer">
        <div className="emoji-picker-preview">
          {hoveredEmoji ? (
            <>
              <span className="emoji-picker-preview-emoji">{hoveredEmoji.e}</span>
              <span className="emoji-picker-preview-name">{hoveredEmoji.n}</span>
            </>
          ) : (
            <span className="emoji-picker-preview-name">
              {searchQuery
                ? `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`
                : categories.find((c) => c.id === activeCategory)?.name || 'Frequently Used'}
            </span>
          )}
        </div>

        <div className="emoji-picker-skin-tones-wrapper">
          <button
            type="button"
            className="emoji-picker-skin-toggle"
            onClick={() => setShowSkinTones((prev) => !prev)}
            title="Skin tone"
            aria-label="Change skin tone"
          >
            {SKIN_TONES.find((t) => t.tone === skinTone)?.preview || '👋'}
          </button>

          {showSkinTones && (
            <div className="emoji-picker-skin-tones">
              {SKIN_TONES.map((t) => (
                <button
                  type="button"
                  key={t.tone || 'default'}
                  className={`emoji-picker-skin-btn ${skinTone === t.tone ? 'emoji-picker-skin-btn--active' : ''}`}
                  onClick={() => handleSkinToneChange(t.tone)}
                  title={t.label}
                  aria-label={t.label}
                >
                  {t.preview}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (mode === 'popover') {
    return createPortal(pickerContent, document.body);
  }

  return pickerContent;
};

export default EmojiPicker;
