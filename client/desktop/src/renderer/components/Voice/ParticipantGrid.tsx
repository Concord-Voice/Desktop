import React, { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUserStore } from '../../stores/userStore';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';
import ParticipantTile from './ParticipantTile';
import { useVoiceMagnification } from './useVoiceMagnification';
import './ParticipantGrid.css';

/** Maximum boost gain: +18 dB ≈ 8x linear. Prevents extreme noise amplification. */
const MAX_BOOST_LINEAR = Math.pow(10, 18 / 20); // ~7.94

/**
 * Hidden audio element that plays a remote participant's audio stream.
 * Routes through a Web Audio GainNode chain for output volume + quiet user boost.
 *
 * Chain: source → analyser → volumeGain → boostGain → destination → <audio>
 */
export const AudioOutput: React.FC<{ stream: MediaStream; outputDeviceId?: string }> = ({
  stream,
  outputDeviceId,
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const volumeGainRef = useRef<GainNode | null>(null);
  const boostGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const boostTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const outputVolume = useAudioSettingsStore((s) => s.outputVolume);
  const quietBoost = useAudioSettingsStore((s) => s.quietBoost);
  const quietBoostThreshold = useAudioSettingsStore((s) => s.quietBoostThreshold);

  // Set up the Web Audio processing chain
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const ctx = new AudioContext({ sampleRate: 48000 });
    ctxRef.current = ctx;

    // Ensure AudioContext is running — can start suspended in some Chromium
    // edge cases even with autoplay-policy=no-user-gesture-required
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('AudioContext resume failed:', err));
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;
    const boostGain = ctx.createGain();
    boostGain.gain.value = 1.0;
    const volumeGain = ctx.createGain();
    volumeGain.gain.value = useAudioSettingsStore.getState().outputVolume / 100;
    const destination = ctx.createMediaStreamDestination();

    source.connect(analyser);
    analyser.connect(volumeGain);
    volumeGain.connect(boostGain);
    boostGain.connect(destination);

    analyserRef.current = analyser;
    boostGainRef.current = boostGain;
    volumeGainRef.current = volumeGain;

    // Play the processed stream through the <audio> element
    el.srcObject = destination.stream;
    el.play().catch((err) => console.warn('Audio element play() rejected:', err));

    // Diagnostic: log AudioContext state and stream health
    console.debug('[AudioOutput] setup', {
      ctxState: ctx.state,
      streamActive: stream.active,
      trackCount: stream.getAudioTracks().length,
      trackState: stream.getAudioTracks()[0]?.readyState,
      trackEnabled: stream.getAudioTracks()[0]?.enabled,
      outputVolume: useAudioSettingsStore.getState().outputVolume,
    });

    // Set output device (Chrome/Electron setSinkId)
    if (outputDeviceId && 'setSinkId' in el) {
      (el as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
        .setSinkId(outputDeviceId)
        .catch((err) => console.warn('Failed to set audio output device:', err));
    }

    return () => {
      if (boostTimerRef.current) {
        clearInterval(boostTimerRef.current);
        boostTimerRef.current = null;
      }
      el.srcObject = null;
      if (ctx.state !== 'closed') ctx.close().catch(() => {});
      ctxRef.current = null;
      volumeGainRef.current = null;
      boostGainRef.current = null;
      analyserRef.current = null;
    };
  }, [stream, outputDeviceId]);

  // Update output volume in real-time
  useEffect(() => {
    if (volumeGainRef.current && ctxRef.current && ctxRef.current.state !== 'closed') {
      volumeGainRef.current.gain.setTargetAtTime(
        outputVolume / 100,
        ctxRef.current.currentTime,
        0.01
      );
    }
  }, [outputVolume]);

  // Quiet user boost: dynamic gain based on audio level
  useEffect(() => {
    // Clear any previous boost polling
    if (boostTimerRef.current) {
      clearInterval(boostTimerRef.current);
      boostTimerRef.current = null;
    }

    const ctx = ctxRef.current;
    const analyser = analyserRef.current;
    const boostGain = boostGainRef.current;

    if (!quietBoost || !ctx || !analyser || !boostGain || ctx.state === 'closed') {
      // Boost disabled — reset gain to unity
      if (boostGain && ctx && ctx.state !== 'closed') {
        boostGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05);
      }
      return;
    }

    // Convert dBFS threshold to linear amplitude (byte-range 0–128 offset from silence)
    const thresholdLinear = Math.pow(10, quietBoostThreshold / 20); // 0..1 linear
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    boostTimerRef.current = setInterval(() => {
      if (
        !analyserRef.current ||
        !boostGainRef.current ||
        !ctxRef.current ||
        ctxRef.current.state === 'closed'
      )
        return;

      analyserRef.current.getByteFrequencyData(dataArray);

      // Average level across frequency bins (0–255 range)
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avgByte = sum / dataArray.length;

      // Convert byte average to linear amplitude (0–1 range, where 255 = 1.0)
      const measuredLinear = avgByte / 255;

      // Silence guard: don't boost below -60 dBFS (just noise)
      const silenceFloor = Math.pow(10, -60 / 20); // ~0.001
      if (measuredLinear <= silenceFloor) {
        // Silence — release boost slowly
        boostGainRef.current.gain.setTargetAtTime(1.0, ctxRef.current.currentTime, 0.3);
        return;
      }

      if (measuredLinear < thresholdLinear) {
        // Below threshold — calculate proportional gain to bring up to threshold
        const multiplier = Math.min(thresholdLinear / measuredLinear, MAX_BOOST_LINEAR);
        boostGainRef.current.gain.setTargetAtTime(multiplier, ctxRef.current.currentTime, 0.08); // 80ms attack
      } else {
        // At or above threshold — no boost needed
        boostGainRef.current.gain.setTargetAtTime(1.0, ctxRef.current.currentTime, 0.3); // 300ms release
      }
    }, 20); // 50 Hz poll

    return () => {
      if (boostTimerRef.current) {
        clearInterval(boostTimerRef.current);
        boostTimerRef.current = null;
      }
    };
  }, [quietBoost, quietBoostThreshold]);

  return <audio ref={audioRef} autoPlay />;
};

/**
 * Audio outputs for all remote participants (hidden <audio> elements).
 * Separated so they can be rendered independently of the visual layout.
 */
export const AudioOutputs: React.FC = () => {
  const participants = useVoiceStore((s) => s.participants);
  const localUserId = useUserStore((s) => s.user?.id);
  const audioOutputDeviceId = useVoiceStore((s) => s.audioOutputDeviceId);
  const participantList = Object.values(participants);

  return (
    <>
      {participantList
        .filter((p) => p.userId !== localUserId && p.audioStream)
        .map((p) => (
          <AudioOutput
            key={`audio-${p.userId}`}
            stream={p.audioStream!}
            outputDeviceId={audioOutputDeviceId || undefined}
          />
        ))}
      {participantList
        .filter((p) => p.userId !== localUserId && p.screenAudioStream)
        .map((p) => (
          <AudioOutput
            key={`screen-audio-${p.userId}`}
            stream={p.screenAudioStream!}
            outputDeviceId={audioOutputDeviceId || undefined}
          />
        ))}
    </>
  );
};

/**
 * Mode A layout: centered user frames grid with no scrollbars.
 * Tiles scale dynamically to fit the viewport.
 */
export const UserFrameGrid: React.FC = () => {
  const participants = useVoiceStore((s) => s.participants);
  const localUserId = useUserStore((s) => s.user?.id);
  const participantList = Object.values(participants);
  const scales = useVoiceMagnification(participants);

  return (
    <div className="user-frame-grid">
      {participantList.map((p) => (
        <ParticipantTile
          key={p.userId}
          participant={p}
          isLocal={p.userId === localUserId}
          magnificationScale={scales[p.userId]}
        />
      ))}
    </div>
  );
};

/**
 * ParticipantGrid — orchestrator for voice visual layout.
 * Renders AudioOutputs + the appropriate visual layout mode.
 * Will be replaced by VoiceView integration in Phase 4.
 */
const ParticipantGrid: React.FC = () => {
  return (
    <>
      <AudioOutputs />
      <UserFrameGrid />
    </>
  );
};

export default ParticipantGrid;
