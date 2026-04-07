import React, { useState, useRef, useEffect } from 'react';
import { ImageOff } from 'lucide-react';
import { gifProvider, type GifResolved } from '../../services/gifProvider';
import './GifEmbed.css';

interface GifEmbedProps {
  slug: string;
  reduceMotion: boolean;
  loadAutomatically: boolean;
  embedsSuppressed?: boolean;
}

/** Inline GIF embed for chat messages.
 *
 *  Resolves a `slug` to a vendor-specific URL via the active `gifProvider`,
 *  then renders an MP4 `<video>` (preferred) or a GIF/WEBP `<img>` fallback.
 *  URLs are passed through verbatim — never construct or modify them.
 *  Reduce-motion mode shows the still rendition as an `<img>` instead.
 *  When `loadAutomatically` is false, the embed shows a "Click to load"
 *  placeholder until the user explicitly taps it.
 */
const GifEmbed: React.FC<GifEmbedProps> = ({
  slug,
  reduceMotion,
  loadAutomatically,
  embedsSuppressed,
}) => {
  const [resolved, setResolved] = useState<GifResolved | null>(null);
  const [error, setError] = useState(false);
  const [userClicked, setUserClicked] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Lazy load via IntersectionObserver — defer the network call until the
  // embed is actually about to enter the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shouldLoad = loadAutomatically || userClicked;

  // Fetch the resolved URLs when the embed becomes visible AND the user is
  // willing to load (auto-load on, or explicitly clicked).
  useEffect(() => {
    if (!isVisible || !shouldLoad || resolved || error) return;
    let cancelled = false;
    gifProvider
      .getBySlug(slug)
      .then((r) => {
        if (!cancelled) setResolved(r);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isVisible, shouldLoad, slug, resolved, error]);

  // Server policy: suppress all embeds
  if (embedsSuppressed) return null;

  let body: React.ReactNode;
  if (!shouldLoad) {
    body = (
      <button
        className="gif-embed-placeholder"
        onClick={() => setUserClicked(true)}
        aria-label="Click to load GIF"
      >
        <ImageOff size={24} />
        <span>Click to load GIF</span>
      </button>
    );
  } else if (error) {
    body = (
      <div className="gif-embed-error">
        <ImageOff size={20} />
        <span>GIF unavailable</span>
      </div>
    );
  } else if (!resolved) {
    body = <div className="gif-embed-skeleton" />;
  } else if (reduceMotion) {
    // Reduce-motion: render the still frame as a static image
    body = (
      <>
        <img
          src={resolved.stillUrl}
          alt={`GIF from ${gifProvider.name}`}
          className="gif-embed-image loaded"
          width={resolved.width}
          height={resolved.height}
          draggable={false}
        />
        <span className="gif-embed-attribution">{gifProvider.poweredByText}</span>
      </>
    );
  } else if (resolved.animatedKind === 'video') {
    // MP4 / WEBM: use a <video> element with the still frame as the poster
    body = (
      <>
        <video
          src={resolved.animatedUrl}
          poster={resolved.stillUrl}
          autoPlay
          loop
          muted
          playsInline
          width={resolved.width}
          height={resolved.height}
          className="gif-embed-video loaded"
          aria-label={`GIF from ${gifProvider.name}`}
        />
        <span className="gif-embed-attribution">{gifProvider.poweredByText}</span>
      </>
    );
  } else {
    // GIF or WEBP: animated image
    body = (
      <>
        <img
          src={resolved.animatedUrl}
          alt={`GIF from ${gifProvider.name}`}
          width={resolved.width}
          height={resolved.height}
          className="gif-embed-image loaded"
          onError={() => setError(true)}
          draggable={false}
        />
        <span className="gif-embed-attribution">{gifProvider.poweredByText}</span>
      </>
    );
  }

  return (
    <div ref={containerRef} className="gif-embed">
      {body}
    </div>
  );
};

export default React.memo(GifEmbed);
