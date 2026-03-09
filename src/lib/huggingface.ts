/**
 * HuggingFace Datasets API integration.
 *
 * Fetches metadata for public datasets hosted on huggingface.co.
 * Docs: https://huggingface.co/docs/hub/api
 */

export interface HuggingFaceDatasetInfo {
  id: string;
  author: string;
  sha: string;
  lastModified: string;
  private: boolean;
  gated: boolean | string;
  disabled: boolean;
  description: string;
  citation: string;
  cardData: Record<string, unknown>;
  tags: string[];
  downloads: number;
  likes: number;
  paperswithcode_id: string | null;
  siblings: Array<{ rfilename: string; size?: number }>;
}

export interface HuggingFaceSplit {
  name: string;
  num_bytes: number;
  num_examples: number;
  dataset: string;
  config: string;
  split: string;
}

export interface HuggingFaceFeature {
  name: string;
  type: string;
}

export interface DatasetMetadata {
  id: string;
  name: string;
  author: string;
  description: string;
  lastModified: string;
  isPrivate: boolean;
  downloads: number;
  likes: number;
  tags: string[];
  cardData: Record<string, unknown>;
  splits: string[];
  features: HuggingFaceFeature[];
  sampleCount: number | null;
  configs: string[];
}

const HF_API_BASE = 'https://huggingface.co/api';
const HF_DATASETS_SERVER = 'https://datasets-server.huggingface.co';

/**
 * Fetch dataset info from HuggingFace API.
 * @param datasetId - e.g. "livecodebench/code_generation_lite"
 */
export async function fetchHuggingFaceDatasetInfo(
  datasetId: string
): Promise<HuggingFaceDatasetInfo> {
  const res = await fetch(`${HF_API_BASE}/datasets/${datasetId}`, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 3600 }, // cache for 1 hour
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to fetch HuggingFace dataset "${datasetId}": ${res.status} ${text}`
    );
  }

  return res.json();
}

/**
 * Fetch available splits for a HF dataset config.
 */
async function fetchSplits(datasetId: string): Promise<HuggingFaceSplit[]> {
  try {
    const res = await fetch(
      `${HF_API_BASE}/datasets/${datasetId}/splits`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.splits ?? [];
  } catch {
    return [];
  }
}

/**
 * Parse a HuggingFace dataset ID from a URL.
 * Supports: https://huggingface.co/datasets/org/name
 */
export function parseHuggingFaceUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'huggingface.co') return null;
    const match = u.pathname.match(/^\/datasets\/([^/]+\/[^/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Fetch full metadata for a HuggingFace dataset, combining info + splits.
 */
export async function fetchDatasetMetadata(
  datasetId: string
): Promise<DatasetMetadata> {
  const [info, splitsData] = await Promise.all([
    fetchHuggingFaceDatasetInfo(datasetId),
    fetchSplits(datasetId),
  ]);

  // Extract unique split names
  const splitNames = [...new Set(splitsData.map((s) => s.name || s.split))];

  // Total sample count
  const sampleCount =
    splitsData.length > 0
      ? splitsData.reduce((sum, s) => sum + (s.num_examples || 0), 0)
      : null;

  // Extract unique config names
  const configs = [...new Set(splitsData.map((s) => s.config).filter(Boolean))];

  // Extract tags
  const tags = [
    ...(info.tags || []),
    ...((info.cardData?.task_categories as string[]) || []),
  ];

  // Compute readable description from card content
  const description =
    info.description ||
    (info.cardData?.description as string) ||
    `HuggingFace dataset: ${datasetId}`;

  return {
    id: info.id,
    name: info.id.split('/').pop() || info.id,
    author: info.author,
    description,
    lastModified: info.lastModified,
    isPrivate: info.private,
    downloads: info.downloads,
    likes: info.likes,
    tags: [...new Set(tags)],
    cardData: info.cardData || {},
    splits: splitNames,
    features: [], // Features require /parquet endpoint; populated on detail page if needed
    sampleCount,
    configs,
  };
}

// ── Row-level data fetching ──────────────────────────────────────────────────

export interface HFRowFeature {
  name: string;
  type: { type?: string; dtype?: string; _type?: string;[key: string]: unknown };
}

export interface HFFirstRowsResponse {
  features: HFRowFeature[];
  rows: Array<{
    row_idx: number;
    row: Record<string, unknown>;
    truncated_cells: string[];
  }>;
}

export interface HFRowsResponse {
  features: HFRowFeature[];
  rows: Array<{
    row_idx: number;
    row: Record<string, unknown>;
    truncated_cells: string[];
  }>;
  num_rows_total: number;
  num_rows_per_page: number;
  partial: boolean;
}

/**
 * Fetch the first rows (up to 100) from a HuggingFace dataset split.
 * Also returns feature/column information so we can offer column-mapping.
 */
export async function fetchFirstRows(
  datasetId: string,
  config: string,
  split: string
): Promise<HFFirstRowsResponse> {
  const url = new URL(`${HF_DATASETS_SERVER}/first-rows`);
  url.searchParams.set('dataset', datasetId);
  url.searchParams.set('config', config);
  url.searchParams.set('split', split);

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to fetch first rows for "${datasetId}" (${config}/${split}): ${res.status} ${text}`
    );
  }

  return res.json();
}

/**
 * Fetch a page of rows from a HuggingFace dataset split.
 * @param offset - 0-based row offset
 * @param length - number of rows to fetch (max 100 per request)
 */
export async function fetchRows(
  datasetId: string,
  config: string,
  split: string,
  offset: number,
  length: number
): Promise<HFRowsResponse> {
  const url = new URL(`${HF_DATASETS_SERVER}/rows`);
  url.searchParams.set('dataset', datasetId);
  url.searchParams.set('config', config);
  url.searchParams.set('split', split);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('length', String(Math.min(length, 100)));

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to fetch rows for "${datasetId}" (${config}/${split}): ${res.status} ${text}`
    );
  }

  return res.json();
}

/**
 * Fetch N rows from a dataset, paginating through the API as needed.
 * Returns plain row objects.
 */
export async function fetchNRows(
  datasetId: string,
  config: string,
  split: string,
  count: number
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 100;
  let offset = 0;

  while (rows.length < count) {
    const remaining = count - rows.length;
    const batchSize = Math.min(remaining, pageSize);
    const data = await fetchRows(datasetId, config, split, offset, batchSize);

    for (const item of data.rows) {
      rows.push(item.row);
      if (rows.length >= count) break;
    }

    // If we got fewer rows than requested, the dataset is exhausted
    if (data.rows.length < batchSize) break;
    offset += data.rows.length;
  }

  return rows;
}
