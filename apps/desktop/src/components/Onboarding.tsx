import { Mic, MonitorPlay, ShieldCheck } from 'lucide-react';
import { Button, Dialog } from './ui';
import { useSettings } from '../stores/settings';

/** First-run notice explaining exactly what ClipLock captures and when. */
export function Onboarding() {
  const { settings, update } = useSettings();
  if (!settings || settings.onboardingComplete) return null;
  const finish = (enableReplay: boolean) =>
    void update((d) => {
      d.onboardingComplete = true;
      if (enableReplay) d.recording.replayEnabled = true;
    });
  return (
    <Dialog
      open
      onClose={() => finish(false)}
      title="Welcome to ClipLock"
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)}>
            Not now
          </Button>
          <Button variant="primary" onClick={() => finish(true)} data-autofocus>
            Turn on Instant Replay
          </Button>
        </>
      }
    >
      <p className="text-fg">Before you start, here is exactly what ClipLock does:</p>
      <ul className="mt-4 space-y-3">
        <li className="flex gap-3">
          <MonitorPlay className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>
            <b className="text-fg">Instant Replay</b> keeps the last {settings.recording.replaySeconds} seconds of your screen and game audio in a temporary buffer.
            Nothing is saved until you press <b className="text-fg">{settings.hotkeys.saveReplay ?? 'the save hotkey'}</b>.
          </span>
        </li>
        <li className="flex gap-3">
          <Mic className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>Your <b className="text-fg">microphone is off</b>. You can turn it on in Settings → Audio.</span>
        </li>
        <li className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>Clips stay on this PC. Nothing is uploaded unless you choose to, and ClipLock collects no telemetry.</span>
        </li>
      </ul>
      <p className="mt-4 text-xs">The tray icon turns red whenever ClipLock is capturing.</p>
    </Dialog>
  );
}
