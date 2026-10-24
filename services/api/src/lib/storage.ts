import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, Backblaze B2, ...). */
export class Storage {
  readonly bucket: string;
  private readonly client: S3Client;
  /** Client used only to sign URLs handed to desktop clients. */
  private readonly publicClient: S3Client;

  constructor(cfg: Pick<Config, 'S3_ENDPOINT' | 'S3_PUBLIC_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'>) {
    const base = {
      region: cfg.S3_REGION,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
      // Only send/verify checksums when the operation requires them; several
      // S3-compatible servers reject the newer default CRC32 headers.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.bucket = cfg.S3_BUCKET;
    this.client = new S3Client({ ...base, ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}) });
    const publicEndpoint = cfg.S3_PUBLIC_ENDPOINT ?? cfg.S3_ENDPOINT;
    this.publicClient = new S3Client({ ...base, ...(publicEndpoint ? { endpoint: publicEndpoint } : {}) });
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const out = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!out.UploadId) throw new Error('storage did not return an upload id');
    return out.UploadId;
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string> {
    return getSignedUrl(this.publicClient, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    for (;;) {
      const out = await this.client.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const p of out.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
      }
      if (!out.IsTruncated || !out.NextPartNumberMarker) break;
      marker = out.NextPartNumberMarker;
    }
    return parts;
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch((e: unknown) => {
      if ((e as { name?: string }).name !== 'NoSuchUpload') throw e;
    });
  }

  async head(key: string): Promise<{ size: number; etag?: string; lastModified?: Date } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0, etag: out.ETag, lastModified: out.LastModified };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }

  get(key: string, range?: string): Promise<GetObjectCommandOutput> {
    return this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
  }

  async put(key: string, body: Readable | Buffer, contentType: string, contentLength: number, cacheControl?: string): Promise<string | undefined> {
    const out = await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: contentLength, CacheControl: cacheControl }),
    );
    return out.ETag;
  }

  /** Deletes every object under `prefix`. Keys are always built from validated ids. */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const list = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (list.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

export const keys = {
  original: (clipId: string) => `originals/${clipId}/source.mp4`,
  rendition: (clipId: string, label: string) => `media/${clipId}/${label}.mp4`,
  thumbnail: (clipId: string) => `media/${clipId}/thumbnail.jpg`,
};
