import { beforeEach, describe, expect, it } from 'vitest';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { resetAllStores } from '../../helpers/store-helpers';

beforeEach(() => {
  resetAllStores();
});

describe('voiceStore capture-lease fields (#87 §3.8)', () => {
  it('starts with no lease, no notice and no declined announcements', () => {
    const s = useVoiceStore.getState();
    expect(s.captureLease).toBe('none');
    expect(s.captureMovedNotice).toBe(false);
    expect(s.captureDeclinedSeq).toBe(0);
  });

  it('setters write their fields and bumpCaptureDeclined increments', () => {
    const s = useVoiceStore.getState();
    s.setCaptureLease('mine');
    s.setCaptureMovedNotice(true);
    s.bumpCaptureDeclined();
    s.bumpCaptureDeclined();
    const after = useVoiceStore.getState();
    expect(after.captureLease).toBe('mine');
    expect(after.captureMovedNotice).toBe(true);
    expect(after.captureDeclinedSeq).toBe(2);
  });

  it('reset() preserves captureLease and captureMovedNotice (emergencyCleanup runs reset)', () => {
    useVoiceStore.getState().setCaptureLease('other');
    useVoiceStore.getState().setCaptureMovedNotice(true);
    useVoiceStore.getState().reset();
    expect(useVoiceStore.getState().captureLease).toBe('other');
    expect(useVoiceStore.getState().captureMovedNotice).toBe(true);
  });

  it('reset() wipes the transient captureDeclinedSeq', () => {
    useVoiceStore.getState().bumpCaptureDeclined();
    useVoiceStore.getState().reset();
    expect(useVoiceStore.getState().captureDeclinedSeq).toBe(0);
  });
});
