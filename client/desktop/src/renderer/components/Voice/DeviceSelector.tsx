import React, { useState, useEffect } from 'react';
import { Mic, Speaker, Video } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import './DeviceSelector.css';

type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

interface DeviceSelectorProps {
  kind: DeviceKind;
}

const LABELS: Record<DeviceKind, string> = {
  audioinput: 'Microphone',
  audiooutput: 'Speaker',
  videoinput: 'Camera',
};

const ICONS: Record<DeviceKind, React.ReactNode> = {
  audioinput: <Mic size={14} />,
  audiooutput: <Speaker size={14} />,
  videoinput: <Video size={14} />,
};

const DeviceSelector: React.FC<DeviceSelectorProps> = ({ kind }) => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const {
    audioInputDeviceId,
    audioOutputDeviceId,
    videoDeviceId,
    setAudioInputDevice,
    setAudioOutputDevice,
    setVideoDevice,
  } = useVoiceStore();

  const currentDeviceId =
    kind === 'audioinput'
      ? audioInputDeviceId
      : kind === 'audiooutput'
        ? audioOutputDeviceId
        : videoDeviceId;

  const setDevice =
    kind === 'audioinput'
      ? setAudioInputDevice
      : kind === 'audiooutput'
        ? setAudioOutputDevice
        : setVideoDevice;

  useEffect(() => {
    const enumerate = async () => {
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        setDevices(allDevices.filter((d) => d.kind === kind));
      } catch {
        // Permission denied or not available
      }
    };

    enumerate();

    // Re-enumerate when devices change (plug/unplug)
    navigator.mediaDevices.addEventListener('devicechange', enumerate);
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate);
  }, [kind]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setDevice(e.target.value);
  };

  return (
    <div className="device-selector">
      <label className="device-selector__label">
        {ICONS[kind]}
        {LABELS[kind]}
      </label>
      <select
        className="device-selector__select"
        value={currentDeviceId || ''}
        onChange={handleChange}
      >
        <option value="">Default</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${LABELS[kind]} ${d.deviceId.slice(0, 8)}`}
          </option>
        ))}
      </select>
    </div>
  );
};

export default DeviceSelector;
