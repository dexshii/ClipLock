import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  // Unlisted clips additionally carry noindex on the page and media responses.
  return { rules: [{ userAgent: '*', allow: ['/', '/c/'], disallow: ['/embed/', '/v1/', '/media/'] }] };
}
