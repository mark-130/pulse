import { z } from "zod";
import { APP_IMAGE_REPO } from "@pulse/shared";

/**
 * Reads the labels of the :latest image from GHCR without credentials. Works only while the package is public.
 * Token, manifest (picking linux/amd64 out of an index), then the config blob, which carries the image labels.
 */
export class RegistryError extends Error {}

const HOST = "https://ghcr.io";
const TIMEOUT_MS = 10_000;
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const tokenSchema = z.object({ token: z.string().min(1) });
const manifestSchema = z.object({
  manifests: z.array(z.object({ digest: z.string(), platform: z.object({ os: z.string().optional(), architecture: z.string().optional() }).optional() })).optional(),
  config: z.object({ digest: z.string() }).optional(),
});
const configSchema = z.object({ created: z.string().optional(), config: z.object({ Labels: z.record(z.string(), z.string()).nullable().optional() }).optional() });

export interface LatestImage {
  sha: string;
  builtAt: string | null;
}

async function get(fetchFn: typeof fetch, url: string, headers: Record<string, string>, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new RegistryError(`Could not reach GHCR (${what}).`);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new RegistryError(`GHCR refused an anonymous read (${what}, ${res.status}). The package is probably private: make ghcr.io/${APP_IMAGE_REPO} public in its GitHub package settings.`);
  }
  if (!res.ok) throw new RegistryError(`GHCR answered ${res.status} (${what}).`);
  return res;
}

async function json<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new RegistryError(`GHCR returned something unexpected (${what}).`);
  return parsed.data;
}

export async function fetchLatestImage(fetchFn: typeof fetch = fetch): Promise<LatestImage> {
  const tokenRes = await get(fetchFn, `${HOST}/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${APP_IMAGE_REPO}:pull`)}`, {}, "token");
  const { token } = await json(tokenRes, tokenSchema, "token");
  const auth = { authorization: `Bearer ${token}`, accept: ACCEPT };
  const base = `${HOST}/v2/${APP_IMAGE_REPO}`;

  let manifest = await json(await get(fetchFn, `${base}/manifests/latest`, auth, "manifest"), manifestSchema, "manifest");
  if (manifest.manifests) {
    const real = manifest.manifests.filter((m) => m.platform?.os === "linux");
    const pick = real.find((m) => m.platform?.architecture === "amd64") ?? real[0];
    if (!pick) throw new RegistryError("The latest image has no linux manifest.");
    manifest = await json(await get(fetchFn, `${base}/manifests/${pick.digest}`, auth, "platform manifest"), manifestSchema, "platform manifest");
  }
  if (!manifest.config) throw new RegistryError("The latest image manifest has no config.");

  const cfg = await json(await get(fetchFn, `${base}/blobs/${manifest.config.digest}`, auth, "config"), configSchema, "config");
  const labels = cfg.config?.Labels ?? {};
  const sha = labels["org.opencontainers.image.revision"]?.trim().toLowerCase();
  if (!sha) throw new RegistryError("The latest image has no revision label. It was built before build labels were added.");
  const builtRaw = labels["org.opencontainers.image.created"] ?? cfg.created ?? null;
  const t = builtRaw ? Date.parse(builtRaw) : NaN;
  return { sha, builtAt: Number.isNaN(t) ? null : new Date(t).toISOString() };
}
