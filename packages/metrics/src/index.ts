export {
  NAMESPACE,
  emit,
  setSink,
  sizeBucket,
  type EmitOptions,
  type MetricValue,
  type Sink,
  type Unit,
} from './emf.js';

export {
  DIMENSIONS,
  METRICS,
  recordGeneration,
  recordGenerationFailure,
  recordMaintenanceRun,
  recordOptimizeJob,
  recordStorageTotals,
  recordRequest,
  recordUpload,
  recordUploadRejection,
  type GenerationMetric,
} from './metrics.js';
