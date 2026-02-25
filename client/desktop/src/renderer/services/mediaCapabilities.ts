/**
 * Media Capabilities Service — probes webcam capabilities and codec support.
 *
 * Detects supported resolutions/framerates for webcams and available video
 * codecs (with hardware acceleration status) for use in quality settings.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebcamCapability {
  width: number;
  height: number;
  frameRate: number;
  label: string; // e.g. "720p30"
}

export interface CodecCapability {
  mimeType: string; // e.g. "video/VP9"
  sdpFmtpLine?: string;
  powerEfficient: boolean; // true = hardware accelerated
  supported: boolean;
}

// ---------------------------------------------------------------------------
// Probe resolutions
// ---------------------------------------------------------------------------

const PROBE_RESOLUTIONS: { width: number; height: number; label: string }[] = [
  { width: 3840, height: 2160, label: '4K' },
  { width: 2560, height: 1440, label: '1440p' },
  { width: 1920, height: 1080, label: '1080p' },
  { width: 1280, height: 720, label: '720p' },
  { width: 640, height: 360, label: '360p' },
];

const PROBE_FRAMERATES = [60, 30, 15];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedWebcamCaps: Map<string, WebcamCapability[]> = new Map();
let cachedCodecCaps: CodecCapability[] | null = null;

/**
 * Enumerate supported resolutions and frame rates for a given webcam.
 * Results are cached per deviceId to avoid repeated probing.
 */
export async function enumerateWebcamCapabilities(
  deviceId: string
): Promise<WebcamCapability[]> {
  if (cachedWebcamCaps.has(deviceId)) {
    return cachedWebcamCaps.get(deviceId)!;
  }

  const capabilities: WebcamCapability[] = [];

  for (const res of PROBE_RESOLUTIONS) {
    for (const fps of PROBE_FRAMERATES) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: deviceId },
            width: { exact: res.width },
            height: { exact: res.height },
            frameRate: { exact: fps },
          },
        });

        // Success — this combination is supported
        capabilities.push({
          width: res.width,
          height: res.height,
          frameRate: fps,
          label: `${res.label}${fps}`,
        });

        // Clean up the test stream
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // Not supported at this resolution/fps — skip
      }
    }
  }

  cachedWebcamCaps.set(deviceId, capabilities);
  return capabilities;
}

/**
 * Detect supported video codecs and their hardware acceleration status.
 * Uses RTCRtpSender.getCapabilities and navigator.mediaCapabilities.
 */
export async function detectCodecCapabilities(): Promise<CodecCapability[]> {
  if (cachedCodecCaps) return cachedCodecCaps;

  const capabilities: CodecCapability[] = [];
  const senderCaps = RTCRtpSender.getCapabilities('video');
  if (!senderCaps) return capabilities;

  // De-duplicate by mimeType
  const seen = new Set<string>();
  const uniqueCodecs = senderCaps.codecs.filter((c) => {
    // Skip RTX, RED, FEC helper codecs
    if (c.mimeType.includes('rtx') || c.mimeType.includes('red') || c.mimeType.includes('ulpfec')) return false;
    if (seen.has(c.mimeType)) return false;
    seen.add(c.mimeType);
    return true;
  });

  for (const codec of uniqueCodecs) {
    let powerEfficient = false;

    // Probe hardware acceleration via MediaCapabilities API
    if ('mediaCapabilities' in navigator) {
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: {
            contentType: codec.mimeType,
            width: 1280,
            height: 720,
            bitrate: 2_000_000,
            framerate: 30,
          },
        } as MediaEncodingConfiguration);
        powerEfficient = info.powerEfficient ?? false;
      } catch {
        // MediaCapabilities may not support WebRTC type on all browsers
      }
    }

    capabilities.push({
      mimeType: codec.mimeType,
      sdpFmtpLine: codec.sdpFmtpLine,
      powerEfficient,
      supported: true,
    });
  }

  cachedCodecCaps = capabilities;
  return capabilities;
}

/** Clear cached capabilities (e.g. on device change) */
export function clearCapabilitiesCache(): void {
  cachedWebcamCaps.clear();
  cachedCodecCaps = null;
}
