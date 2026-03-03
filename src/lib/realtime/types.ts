export type RealtimeTopic = 'datasets';

export interface DatasetSummaryUpdatedPayload {
  datasetId: string;
  summary: {
    updatedAt: string;
    sampleCount: number;
    samplesWithModelScores: number;
    samplesWithHumanScores: number;
    averageModelScore: number | null;
    averageHumanScore: number | null;
  };
}

export interface RealtimeEventMap {
  'dataset.summary.updated': {
    topic: 'datasets';
    payload: DatasetSummaryUpdatedPayload;
  };
}

export type RealtimeEventName = keyof RealtimeEventMap;

export interface RealtimeEnvelope<TName extends RealtimeEventName = RealtimeEventName> {
  id: string;
  type: TName;
  topic: RealtimeEventMap[TName]['topic'];
  timestamp: string;
  payload: RealtimeEventMap[TName]['payload'];
}

export type RealtimeListener = (event: RealtimeEnvelope) => void;
