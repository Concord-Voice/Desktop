import { useState, useRef, useCallback } from 'react';

export interface UseImageUploadOptions {
  maxSize: number;
  allowedTypes: string[];
  onError: (message: string | undefined) => void;
  initialUrl?: string | null;
}

export interface UseImageUploadReturn {
  preview: string | null;
  imageUrl: string | null;
  removed: boolean;
  pendingFile: File | null;
  showCrop: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleClick: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleCropConfirm: (url: string) => void;
  handleCropCancel: () => void;
  handleRemove: () => void;
  reset: (newInitialUrl?: string | null) => void;
}

export function useImageUpload({
  maxSize,
  allowedTypes,
  onError,
  initialUrl,
}: UseImageUploadOptions): UseImageUploadReturn {
  const [preview, setPreview] = useState<string | null>(initialUrl ?? null);
  const [imageUrl, setImageUrl] = useState<string | null>(initialUrl ?? null);
  const [removed, setRemoved] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [showCrop, setShowCrop] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const clearFileInput = useCallback(() => {
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!allowedTypes.includes(file.type)) {
        onError('Only PNG, JPEG, GIF, and WebP images are allowed');
        clearFileInput();
        return;
      }

      const sizeMB = maxSize >= 2 * 1024 * 1024 ? '2MB' : '1MB';
      if (file.size > maxSize) {
        onError(`Image must be smaller than ${sizeMB}`);
        clearFileInput();
        return;
      }

      onError(undefined);
      setPendingFile(file);
      setShowCrop(true);
    },
    [allowedTypes, maxSize, onError]
  );

  const handleCropConfirm = useCallback(
    (url: string) => {
      setPreview(url);
      setImageUrl(url);
      setRemoved(false);
      setPendingFile(null);
      setShowCrop(false);
      clearFileInput();
    },
    [clearFileInput]
  );

  const handleCropCancel = useCallback(() => {
    setPendingFile(null);
    setShowCrop(false);
    clearFileInput();
  }, [clearFileInput]);

  const handleRemove = useCallback(() => {
    setPreview(null);
    setImageUrl(null);
    setRemoved(true);
    clearFileInput();
  }, [clearFileInput]);

  const reset = useCallback((newInitialUrl?: string | null) => {
    const url = newInitialUrl ?? null;
    setPreview(url);
    setImageUrl(url);
    setRemoved(false);
    setPendingFile(null);
    setShowCrop(false);
  }, []);

  return {
    preview,
    imageUrl,
    removed,
    pendingFile,
    showCrop,
    fileInputRef,
    handleClick,
    handleKeyDown,
    handleChange,
    handleCropConfirm,
    handleCropCancel,
    handleRemove,
    reset,
  };
}
