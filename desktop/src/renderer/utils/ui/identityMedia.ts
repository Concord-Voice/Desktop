import { readBoundedBody } from '../runtime/boundedResponseBody';

// Leave room for animated images that grow during server-side re-encoding.
export const MAX_IDENTITY_MEDIA_BYTES = 128 * 1024 * 1024;
export const IDENTITY_MEDIA_TIMEOUT_MS = 60_000;

export async function readIdentityMedia(response: Response, contentType: string): Promise<Blob> {
  // The reader's arrayBuffer fallback buffers without a limit; identity media must stream.
  if (!response.body) throw new Error('Identity media response has no stream');
  const bytes = await readBoundedBody(response, MAX_IDENTITY_MEDIA_BYTES);
  return new Blob([bytes], { type: contentType });
}
