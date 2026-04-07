import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Download, FileText, Film, Music, File, Loader2 } from 'lucide-react';
import { apiFetch } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
import { decryptFile, formatFileSize } from '../../utils/attachmentCrypto';
import type { AttachmentSummary } from '../../types/chat';
import './AttachmentDisplay.css';

interface AttachmentDisplayProps {
  readonly attachments: AttachmentSummary[];
  readonly channelId: string;
  readonly isEncrypted: boolean;
}

interface AttachmentItemProps {
  readonly attachment: AttachmentSummary;
  readonly channelId: string;
  readonly isEncrypted: boolean;
}

// LRU cache for decrypted blob URLs — evicts oldest entries to bound memory.
const BLOB_CACHE_MAX = 50;
const blobUrlCache = new Map<string, string>();

function cacheBlobUrl(fileId: string, url: string): void {
  // Evict oldest entry if at capacity (Map preserves insertion order)
  if (blobUrlCache.size >= BLOB_CACHE_MAX) {
    const oldest = blobUrlCache.keys().next().value!;
    URL.revokeObjectURL(blobUrlCache.get(oldest)!);
    blobUrlCache.delete(oldest);
  }
  blobUrlCache.set(fileId, url);
}

async function fetchAndDecrypt(
  fileId: string,
  channelId: string,
  isEncrypted: boolean
): Promise<string> {
  const cached = blobUrlCache.get(fileId);
  if (cached) {
    // Move to end for LRU freshness
    blobUrlCache.delete(fileId);
    blobUrlCache.set(fileId, cached);
    return cached;
  }

  const response = await apiFetch(`/api/v1/media/attachments/${fileId}`);
  if (!response.ok) throw new Error(`Failed to fetch attachment (${response.status})`);

  let data = await response.arrayBuffer();
  const mimeType = response.headers.get('X-File-Mime-Type') || 'application/octet-stream';

  if (isEncrypted) {
    const channelKey = await e2eeService.getChannelKey(channelId);
    data = await decryptFile(data, channelKey);
  }

  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  cacheBlobUrl(fileId, url);
  return url;
}

function FileIcon({ fileType }: { readonly fileType: string }) {
  switch (fileType) {
    case 'video':
      return <Film size={20} />;
    case 'audio':
      return <Music size={20} />;
    case 'photo':
    case 'animated':
      return <FileText size={20} />;
    default:
      return <File size={20} />;
  }
}

function ImageAttachment({ attachment, channelId, isEncrypted }: AttachmentItemProps) {
  const [url, setUrl] = useState<string | null>(blobUrlCache.get(attachment.id) || null);
  const [loading, setLoading] = useState(!url);
  const [error, setError] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const blobUrl = await fetchAndDecrypt(attachment.id, channelId, isEncrypted);
      setUrl(blobUrl);
    } catch {
      // Fetch or decryption failed — show inline error state
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [attachment.id, channelId, isEncrypted]);

  useEffect(() => {
    if (url) return; // already loaded
    const el = containerRef.current;
    if (!el) return;

    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          load();
          observerRef.current?.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observerRef.current.observe(el);

    return () => observerRef.current?.disconnect();
  }, [url, load]);

  return (
    <div ref={containerRef} className="attachment-image-container">
      {loading && (
        <div className="attachment-loading">
          <Loader2 size={20} className="spinner" />
        </div>
      )}
      {error && <div className="attachment-error">Failed to load image</div>}
      {url && (
        <img
          src={url}
          alt={`Attachment ${attachment.id}`}
          className="attachment-image"
          loading="lazy"
        />
      )}
    </div>
  );
}

function MediaAttachment({ attachment, channelId, isEncrypted }: AttachmentItemProps) {
  const [url, setUrl] = useState<string | null>(blobUrlCache.get(attachment.id) || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Videos auto-lazy-load so the browser can render the first frame as a natural
  // poster — no separate thumbnail pipeline needed. Audio stays click-to-load
  // because there's nothing visual to gain from prefetching the bytes.
  const autoLoad = attachment.file_type === 'video';

  const load = useCallback(async () => {
    if (url) return;
    setError(false);
    setLoading(true);
    try {
      const blobUrl = await fetchAndDecrypt(attachment.id, channelId, isEncrypted);
      setUrl(blobUrl);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [attachment.id, channelId, isEncrypted, url]);

  useEffect(() => {
    if (!autoLoad || url) return;
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          load();
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoLoad, url, load]);

  const Icon = attachment.file_type === 'video' ? Film : Music;
  const label = attachment.file_type === 'video' ? 'video' : 'audio';
  const sizeLabel = formatFileSize(attachment.file_size);
  let loadTitle = `Load ${label}`;
  if (error) loadTitle = `Failed to load ${label} — retry`;
  else if (loading) loadTitle = `Loading ${label}…`;

  return (
    <div className="attachment-media-container" ref={containerRef}>
      {url && attachment.file_type === 'video' && (
        <video src={url} controls className="attachment-video" preload="metadata">
          <track kind="captions" />
        </video>
      )}
      {url && attachment.file_type === 'audio' && (
        <audio src={url} controls className="attachment-audio" preload="metadata">
          <track kind="captions" />
        </audio>
      )}
      {!url && (
        <button
          className="attachment-load-btn attachment-load-btn-rich"
          onClick={load}
          disabled={loading}
        >
          <Icon size={20} />
          <div className="attachment-load-info">
            <span className="attachment-load-title">{loadTitle}</span>
            <span className="attachment-load-meta">
              {attachment.mime_type} · {sizeLabel}
            </span>
          </div>
        </button>
      )}
    </div>
  );
}

function FileAttachment({ attachment, channelId, isEncrypted }: AttachmentItemProps) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blobUrl = await fetchAndDecrypt(attachment.id, channelId, isEncrypted);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `attachment-${attachment.id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      // Non-fatal: download failed, no UI feedback needed for file cards
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="attachment-file-card">
      <FileIcon fileType={attachment.file_type} />
      <div className="attachment-file-info">
        <span className="attachment-file-type">{attachment.mime_type}</span>
        <span className="attachment-file-size">{formatFileSize(attachment.file_size)}</span>
      </div>
      <button
        className="attachment-download-btn"
        onClick={handleDownload}
        disabled={downloading}
        aria-label="Download attachment"
      >
        {downloading ? <Loader2 size={16} className="spinner" /> : <Download size={16} />}
      </button>
    </div>
  );
}

const AttachmentDisplay: React.FC<AttachmentDisplayProps> = ({
  attachments,
  channelId,
  isEncrypted,
}) => {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="attachment-display">
      {attachments.map((attachment) => {
        if (attachment.file_type === 'photo' || attachment.file_type === 'animated') {
          return (
            <ImageAttachment
              key={attachment.id}
              attachment={attachment}
              channelId={channelId}
              isEncrypted={isEncrypted}
            />
          );
        }
        if (attachment.file_type === 'video' || attachment.file_type === 'audio') {
          return (
            <MediaAttachment
              key={attachment.id}
              attachment={attachment}
              channelId={channelId}
              isEncrypted={isEncrypted}
            />
          );
        }
        return (
          <FileAttachment
            key={attachment.id}
            attachment={attachment}
            channelId={channelId}
            isEncrypted={isEncrypted}
          />
        );
      })}
    </div>
  );
};

export default AttachmentDisplay;
