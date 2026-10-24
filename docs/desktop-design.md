# Desktop workspace design

ClipLock is a media utility. The interface gives space to recordings and keeps
capture controls near the task rather than presenting a dashboard of settings.

## Layout

- A 188 px navigation rail separates workspace/library/recording from account and
  configuration pages. Native Windows window chrome remains native.
- Home uses a flexible media area and a 296 px recorder inspector. Replay saving
  and recording come first; source and quality configuration follow.
- The status strip reports the selected/effective source, output format and mic
  state from existing settings/recorder state. It does not fabricate performance data.
- Recent clips are loaded independently of the library's search/game filters.
  Favorites are a local view of those clips. Loading and errors are distinct from
  an empty library.
- Library grid tiles prioritize the thumbnail and title. Technical metadata stays
  secondary. Dense list columns keep a minimum width and scroll on smaller windows.

## Visual system

Inter, restrained type sizes, graphite surfaces and subtle separators form the
desktop theme. One light blue accent identifies the primary save action and focus;
red indicates recording or errors. Desktop token overrides live in
`apps/desktop/src/index.css`, so the hosted public player retains its existing theme.
Buttons and inputs use small radii, visible focus states and consistent heights.
Reduced-motion preferences suppress transitions and looping animations.

No sample clips, simulated metrics or preview IPC mocks are included in the app.
Browser verification fixtures live outside the repository and screenshots must be
identified as fixture previews rather than evidence of hardware recording.

## Verification targets

Check empty and populated libraries, favorites, search/list views, unavailable
recorder recovery, replay saving and the recording/paused states. Verify controls
lock correctly during settings changes and recording while replay saves still work.
Keyboard access, long titles, missing media and a minimum 980 x 640 Windows window
remain part of manual release QA. Preserve existing settings and recording behavior.
