import { DatasetMetadata } from './huggingface';
import { DatasetEvaluationSummary } from './dataset-evaluation-summary';

interface RemoteMetadataWithSummary extends Record<string, unknown> {
  evaluationSummary?: DatasetEvaluationSummary;
}

/**
 * Build the update object for a dataset refresh, preserving evaluationSummary
 * and using local sample count instead of HuggingFace corpus total.
 *
 * @param existingRemoteMetadataJson - The existing remoteMetadata JSON string (or null)
 * @param freshHfMeta - Fresh metadata from HuggingFace API
 * @param localSampleCount - The count of local samples from the database
 * @returns Object with remoteMetadata (JSON string) and sampleCount to update
 */
export function buildRefreshUpdate(
  existingRemoteMetadataJson: string | null | undefined,
  freshHfMeta: DatasetMetadata,
  localSampleCount: number
): { remoteMetadata: string; sampleCount: number } {
  // Parse existing metadata, preserving evaluationSummary if present
  let existingMetadata: RemoteMetadataWithSummary = {};
  if (existingRemoteMetadataJson) {
    try {
      const parsed = JSON.parse(existingRemoteMetadataJson);
      if (parsed && typeof parsed === 'object') {
        existingMetadata = parsed as RemoteMetadataWithSummary;
      }
    } catch {
      // ignore malformed metadata
    }
  }

  // Merge: fresh HF metadata with existing evaluationSummary preserved
  const mergedMetadata: RemoteMetadataWithSummary = {
    ...freshHfMeta,
    evaluationSummary: existingMetadata.evaluationSummary,
  };

  return {
    remoteMetadata: JSON.stringify(mergedMetadata),
    sampleCount: localSampleCount,
  };
}
