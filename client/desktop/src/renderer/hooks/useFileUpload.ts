import { useState, useCallback, useRef } from 'react';
import { apiFetch, safeJson } from '../services/apiClient';
import { e2eeService } from '../services/e2eeService';
import {
  encryptFile,
  classifyFileType,
  formatFileSize,
  isImageType,
  MAX_FILE_SIZE,
  MAX_ATTACHMENTS,
} from '../utils/attachmentCrypto';
import type { AttachmentSummary } from '../types/chat';

const DEFAULT_MIME = 'application/octet-stream';

export interface FileUploadState {
  file: File;
  id?: string;
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
  previewUrl?: string;
}

interface UploadResult {
  ids: string[];
  summaries: AttachmentSummary[];
}

interface UploadResponse {
  file_id: string;
  file_type: string;
  mime_type: string;
  file_size: number;
}

/**
 * Validates files before adding to the queue.
 * Returns an error string if validation fails, null if valid.
 */
export function validateFiles(newFiles: File[], existingCount: number): string | null {
  const totalCount = existingCount + newFiles.length;
  if (totalCount > MAX_ATTACHMENTS) {
    return `Maximum ${MAX_ATTACHMENTS} attachments per message`;
  }
  for (const file of newFiles) {
    if (file.size > MAX_FILE_SIZE) {
      return `${file.name} exceeds the ${formatFileSize(MAX_FILE_SIZE)} limit`;
    }
    if (file.size === 0) {
      return `${file.name} is empty`;
    }
  }
  return null;
}

function fileMime(entry: FileUploadState): string {
  return entry.file.type || DEFAULT_MIME;
}

function buildSummary(id: string, entry: FileUploadState): AttachmentSummary {
  return {
    id,
    file_type: classifyFileType(entry.file.type),
    mime_type: fileMime(entry),
    file_size: entry.file.size,
  };
}

function isDoneWithId(f: FileUploadState): f is FileUploadState & { id: string } {
  return f.status === 'done' && f.id != null;
}

function collectDoneFiles(files: FileUploadState[]): UploadResult {
  const done = files.filter(isDoneWithId);
  return {
    ids: done.map((f) => f.id),
    summaries: done.map((f) => buildSummary(f.id, f)),
  };
}

async function uploadSingleFile(
  entry: FileUploadState,
  channelKey: CryptoKey | null,
  keyVersion: number | undefined,
  channelId: string,
  conversationId?: string
): Promise<UploadResponse> {
  const formData = await encryptAndBuildForm(
    entry,
    channelKey,
    keyVersion,
    channelId,
    conversationId
  );
  const response = await apiFetch('/api/v1/media/upload/attachment', {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(errBody || `Upload failed (${response.status})`);
  }
  return safeJson<UploadResponse>(response);
}

async function encryptAndBuildForm(
  entry: FileUploadState,
  channelKey: CryptoKey | null,
  keyVersion: number | undefined,
  channelId: string,
  conversationId?: string
): Promise<FormData> {
  const fileData = await entry.file.arrayBuffer();
  const uploadData = channelKey ? await encryptFile(fileData, channelKey) : fileData;

  const formData = new FormData();
  formData.append('file', new Blob([uploadData]), entry.file.name);
  formData.append('file_type', classifyFileType(entry.file.type));
  formData.append('mime_type', entry.file.type || DEFAULT_MIME);
  if (keyVersion !== undefined) {
    formData.append('key_version', String(keyVersion));
  }
  if (conversationId) {
    formData.append('conversation_id', conversationId);
  } else {
    formData.append('channel_id', channelId);
  }
  return formData;
}

export function useFileUpload() {
  const [files, setFiles] = useState<FileUploadState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const abortRef = useRef(false);
  const validationResultRef = useRef<string | null>(null);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const fileArray = Array.from(newFiles);

    setFiles((prev) => {
      const error = validateFiles(fileArray, prev.length);
      validationResultRef.current = error;
      if (error) {
        return prev;
      }

      const newEntries: FileUploadState[] = fileArray.map((file) => ({
        file,
        progress: 0,
        status: 'pending' as const,
        previewUrl: isImageType(file.type) ? URL.createObjectURL(file) : undefined,
      }));
      return [...prev, ...newEntries];
    });

    return validationResultRef.current;
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => {
      const removed = prev[index];
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setFiles((prev) => {
      for (const f of prev) {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      }
      return [];
    });
  }, []);

  const uploadAll = useCallback(
    async (
      channelId: string,
      isEncrypted: boolean,
      conversationId?: string
    ): Promise<UploadResult> => {
      const hasPending = files.some((f) => f.status === 'pending');
      if (!hasPending) {
        return collectDoneFiles(files);
      }

      setIsUploading(true);
      abortRef.current = false;

      const ids: string[] = [];
      const summaries: AttachmentSummary[] = [];

      let channelKey: CryptoKey | null = null;
      let keyVersion: number | undefined;
      if (isEncrypted) {
        const keyChannelId = conversationId || channelId;
        channelKey = await e2eeService.getChannelKey(keyChannelId);
        keyVersion = e2eeService.getCurrentKeyVersion(keyChannelId);
      }

      for (let i = 0; i < files.length; i++) {
        if (abortRef.current) break;
        const entry = files[i];

        // Collect already-done files
        if (entry.status !== 'pending') {
          if (isDoneWithId(entry)) {
            ids.push(entry.id);
            summaries.push(buildSummary(entry.id, entry));
          }
          continue;
        }

        // Mark uploading
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, status: 'uploading' as const, progress: 0 } : f
          )
        );

        try {
          const result = await uploadSingleFile(
            entry,
            channelKey,
            keyVersion,
            channelId,
            conversationId
          );
          ids.push(result.file_id);
          summaries.push(buildSummary(result.file_id, entry));
          setFiles((prev) =>
            prev.map((f, idx) =>
              idx === i ? { ...f, status: 'done' as const, progress: 100, id: result.file_id } : f
            )
          );
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Upload failed';
          setFiles((prev) =>
            prev.map((f, idx) =>
              idx === i ? { ...f, status: 'error' as const, error: errorMsg } : f
            )
          );
        }
      }

      setIsUploading(false);
      return { ids, summaries };
    },
    [files]
  );

  const hasFiles = files.length > 0;

  return {
    files,
    addFiles,
    removeFile,
    clearFiles,
    uploadAll,
    isUploading,
    hasFiles,
  };
}
