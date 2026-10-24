import { z } from 'zod';
import {
  CLIP_ID_PATTERN,
  CLIP_TITLE_MAX_LENGTH,
  CLIP_VISIBILITIES,
  CLOUD_CLIP_STATUSES,
  MAX_PART_URLS_PER_REQUEST,
} from './constants.js';

export const clipIdSchema = z.string().regex(CLIP_ID_PATTERN, 'Invalid clip id');
export const visibilitySchema = z.enum(CLIP_VISIBILITIES);
export const cloudClipStatusSchema = z.enum(CLOUD_CLIP_STATUSES);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

/** Passwords: length is what matters; no composition rules (NIST SP 800-63B). */
const passwordSchema = z.string().min(10, 'Password must be at least 10 characters').max(256);

export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[\p{L}\p{N}_ .-]+$/u, 'Display name contains unsupported characters');

export const clipTitleSchema = z.string().trim().min(1).max(CLIP_TITLE_MAX_LENGTH);

// ---------------------------------------------------------------- auth

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshBody = z.infer<typeof refreshBodySchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const sessionResponseSchema = z.object({
  user: userSchema,
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const deleteAccountBodySchema = z.object({
  password: z.string().min(1).max(256),
});

// ---------------------------------------------------------------- clips

export const createClipBodySchema = z.object({
  title: clipTitleSchema,
  gameName: z.string().trim().max(100).nullish(),
  durationMs: z.number().int().positive().max(24 * 60 * 60 * 1000),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be lowercase hex'),
  visibility: visibilitySchema.default('unlisted'),
  allowDownload: z.boolean().default(true),
  recordedAt: z.iso.datetime().nullish(),
});
export type CreateClipBody = z.infer<typeof createClipBodySchema>;

export const updateClipBodySchema = z
  .object({
    title: clipTitleSchema.optional(),
    visibility: visibilitySchema.optional(),
    allowDownload: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateClipBody = z.infer<typeof updateClipBodySchema>;

export const cloudClipSchema = z.object({
  id: clipIdSchema,
  title: z.string(),
  gameName: z.string().nullable(),
  status: cloudClipStatusSchema,
  visibility: visibilitySchema,
  allowDownload: z.boolean(),
  durationMs: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  error: z.string().nullable(),
  /** Public page URL; only meaningful once status is READY. */
  shareUrl: z.string(),
  /** Direct MP4 URL; null until a playback rendition exists. */
  mediaUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
});
export type CloudClip = z.infer<typeof cloudClipSchema>;

export const uploadSessionSchema = z.object({
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
});
export type UploadSession = z.infer<typeof uploadSessionSchema>;

export const createClipResponseSchema = z.object({
  clip: cloudClipSchema,
  /** null when an identical, already uploaded clip was found (duplicate prevention). */
  upload: uploadSessionSchema.nullable(),
  duplicate: z.boolean(),
});
export type CreateClipResponse = z.infer<typeof createClipResponseSchema>;

export const partUrlsBodySchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(MAX_PART_URLS_PER_REQUEST),
});
export const partUrlsResponseSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.string() })),
  expiresAt: z.string(),
});
export type PartUrlsResponse = z.infer<typeof partUrlsResponseSchema>;

export const uploadedPartsResponseSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string(), size: z.number().int() })),
});
export type UploadedPartsResponse = z.infer<typeof uploadedPartsResponseSchema>;

export const completeUploadBodySchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(10_000),
});
export type CompleteUploadBody = z.infer<typeof completeUploadBodySchema>;

export const clipListResponseSchema = z.object({
  clips: z.array(cloudClipSchema),
  nextCursor: z.string().nullable(),
});
export type ClipListResponse = z.infer<typeof clipListResponseSchema>;

// ---------------------------------------------------------------- public view

export const renditionSchema = z.object({
  label: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  sizeBytes: z.number().int(),
  contentType: z.string(),
  url: z.string(),
});
export type Rendition = z.infer<typeof renditionSchema>;

export const publicClipSchema = z.object({
  id: clipIdSchema,
  title: z.string(),
  gameName: z.string().nullable(),
  author: z.object({ displayName: z.string() }),
  durationMs: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  createdAt: z.string(),
  visibility: visibilitySchema,
  allowDownload: z.boolean(),
  pageUrl: z.string(),
  mediaUrl: z.string(),
  thumbnailUrl: z.string(),
  renditions: z.array(renditionSchema),
  /** Present only when downloads are allowed. */
  downloadUrl: z.string().nullable(),
});
export type PublicClip = z.infer<typeof publicClipSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
