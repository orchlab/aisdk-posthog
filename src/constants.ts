/**
 * Synthetic span ID assigned to the parent context when `withExecutionTrace`
 * starts a new root span. Both the factory (which writes it) and the exporter
 * (which compares against it to detect "this is the execution root") need to
 * agree on the value, so it lives in one place.
 *
 * The value is intentionally not a real OTel span ID — it never appears in
 * a trace tree, only in `parentSpanContext.spanId`.
 */
export const SYNTHETIC_ROOT_SPAN_ID = '0000000000000001';

/**
 * Span attribute the factory stamps on every span created by
 * `withExecutionTrace`. The exporter reads it to identify execution-trace
 * spans without relying on a magic operationId prefix, so consumers are
 * free to use any operationId they want (e.g. `'chat.reply'`,
 * `'ingest.batch'`).
 */
export const EXECUTION_SPAN_ATTR = 'aisdk_posthog.execution';
