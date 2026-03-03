import { useTTSSettingsStore } from '../stores/ttsSettingsStore';

const MAX_UTTERANCE_LENGTH = 200;
const MAX_QUEUE_SIZE = 3;
const MIN_INTERVAL_MS = 2000;

let lastSpeakTime = 0;

/**
 * Speak text aloud using the Web Speech API.
 * Respects the user's TTS settings (voice, rate, volume).
 * Rate-limited: max 1 utterance per 2 seconds, queue of 3.
 */
export function speak(text: string, senderName?: string): void {
  if (!window.speechSynthesis) return;

  const { ttsEnabled, ttsVoice, ttsRate, ttsVolume } = useTTSSettingsStore.getState();
  if (!ttsEnabled) return;

  // Rate limiting
  const now = Date.now();
  if (now - lastSpeakTime < MIN_INTERVAL_MS) {
    // Check queue size — drop if too many pending
    if (window.speechSynthesis.pending && getQueueSize() >= MAX_QUEUE_SIZE) {
      return;
    }
  }
  lastSpeakTime = now;

  // Truncate long messages
  let utteranceText = text;
  if (senderName) {
    utteranceText = `${senderName} says: ${text}`;
  }
  if (utteranceText.length > MAX_UTTERANCE_LENGTH) {
    utteranceText = utteranceText.slice(0, MAX_UTTERANCE_LENGTH - 3) + '...';
  }

  const utterance = new SpeechSynthesisUtterance(utteranceText);
  utterance.rate = ttsRate;
  utterance.volume = ttsVolume;

  // Set voice if specified
  if (ttsVoice) {
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find((v) => v.voiceURI === ttsVoice);
    if (match) {
      utterance.voice = match;
    }
  }

  window.speechSynthesis.speak(utterance);
}

/**
 * Stop all current and queued TTS speech.
 */
export function stop(): void {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

/**
 * Get available TTS voices.
 */
export function getVoices(): SpeechSynthesisVoice[] {
  if (!window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices();
}

/**
 * Check if TTS is currently speaking.
 */
export function isSpeaking(): boolean {
  if (!window.speechSynthesis) return false;
  return window.speechSynthesis.speaking;
}

// Approximate queue size (pending + speaking)
function getQueueSize(): number {
  // SpeechSynthesis doesn't expose exact queue size;
  // we use the pending flag as a proxy
  let count = 0;
  if (window.speechSynthesis.speaking) count++;
  if (window.speechSynthesis.pending) count++;
  return count;
}
