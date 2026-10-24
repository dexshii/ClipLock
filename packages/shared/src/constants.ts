export const APP_NAME = 'ClipLock';
export const APP_SLOGAN = 'Capture it. Keep it.';

/** Preset Instant Replay lengths offered in the UI. Custom values are also allowed. */
export const REPLAY_DURATION_PRESETS_SECONDS = [15, 30, 60, 120, 300] as const;
export const MIN_REPLAY_SECONDS = 5;
export const MAX_REPLAY_SECONDS = 20 * 60;

/**
 * Lifecycle of a clip as seen from the desktop app.
 * LOCAL → QUEUED → UPLOADING → PROCESSING → READY, with FAILED reachable from any
 * non-terminal state.
 */
export const LOCAL_CLIP_STATUSES = [
  'LOCAL',
  'QUEUED',
  'UPLOADING',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;
export type LocalClipStatus = (typeof LOCAL_CLIP_STATUSES)[number];

/** Lifecycle of a clip on the server. A server clip only exists once an upload was requested. */
export const CLOUD_CLIP_STATUSES = ['UPLOADING', 'PROCESSING', 'READY', 'FAILED'] as const;
export type CloudClipStatus = (typeof CLOUD_CLIP_STATUSES)[number];

export const CLIP_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type ClipVisibility = (typeof CLIP_VISIBILITIES)[number];

/** S3 multipart uploads need parts of at least 5 MiB (except the last). */
export const UPLOAD_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const MAX_PART_URLS_PER_REQUEST = 100;

/** Public clip identifiers are 10 base62 characters. */
export const CLIP_ID_LENGTH = 10;
export const CLIP_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

export const CLIP_TITLE_MAX_LENGTH = 100;
