import { describe, expect, it } from 'vitest';
import { applyCaptureProfile, estimatedBytesPerHour, quickReplayDurations, selectedCaptureProfile } from './capture';
import type { AppSettings } from './ipc';

function settings(): AppSettings {
  return {
    general: { launchOnStartup: false, startMinimized: false, closeToTray: true, notifications: true,
      soundEffects: true, gameDetection: true, customGames: [] },
    recording: { replayEnabled: false, replaySeconds: 30, captureTarget: 'display', monitorIndex: 1 },
    video: { outputHeight: 1080, fps: 60, bitrateKbps: 20_000, codec: 'h264', encoder: 'auto', captureCursor: false },
    audio: { systemEnabled: true, systemDeviceId: null, systemVolume: 1, micEnabled: false,
      micDeviceId: null, micVolume: 1, separateTracks: false, bitrateKbps: 192 },
    hotkeys: { saveReplay: 'Alt+F10', toggleRecording: 'Alt+F9', pauseRecording: null, toggleReplay: null, toggleMicMute: null },
    storage: { clipsDir: null, bufferDir: null, libraryWarningGb: 50 },
    uploads: { serverUrl: '', defaultVisibility: 'unlisted', allowDownload: true },
    privacy: { announceCapture: true }, onboardingComplete: true,
  };
}

describe('capture profiles', () => {
  it('applies each profile without enabling microphone, replay or uploads', () => {
    for (const id of ['performance', 'balanced', 'quality'] as const) {
      const s = settings();
      const original = structuredClone(s);
      applyCaptureProfile(s, id);
      expect(selectedCaptureProfile(s)).toBe(id);
      expect({ ...s, video: original.video }).toEqual(original);
      expect(s.video.captureCursor).toBe(false);
    }
  });
  it('marks manually tuned encoding settings as custom', () => {
    const s = settings();
    expect(selectedCaptureProfile(s)).toBe('balanced');
    s.video.encoder = 'nvenc';
    expect(selectedCaptureProfile(s)).toBe('custom');
    applyCaptureProfile(s, 'performance');
    expect(s.video).toMatchObject({ outputHeight: 720, fps: 30, bitrateKbps: 8000, codec: 'h264', encoder: 'auto' });
  });
});

describe('replay durations and storage estimates', () => {
  it('never offers a quick-save longer than the configured buffer', () => {
    expect(quickReplayDurations(5)).toEqual([5]);
    expect(quickReplayDurations(30)).toEqual([5, 15, 30]);
    expect(quickReplayDurations(45)).toEqual([5, 15, 30]);
    expect(quickReplayDurations(120)).toEqual([5, 15, 30, 60, 120]);
  });
  it('includes separate audio tracks and excludes disabled audio', () => {
    const s = settings();
    const base = estimatedBytesPerHour(s);
    s.audio.micEnabled = true;
    s.audio.separateTracks = true;
    expect(estimatedBytesPerHour(s) - base).toBe(192 * 2 * 1000 / 8 * 3600);
    s.audio.micEnabled = s.audio.systemEnabled = false;
    expect(estimatedBytesPerHour(s)).toBe(20_000 * 1000 / 8 * 3600);
  });
});
