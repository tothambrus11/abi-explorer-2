// Typed message protocol between the main thread and the clang worker.
// Runtime-validated with valibot on both sides so a malformed message can
// never silently wedge the pipeline.

import * as v from 'valibot';

export const CompileRequestSchema = v.object({
  type: v.literal('compile'),
  id: v.number(),
  argv0: v.picklist(['clang', 'clang++']),
  args: v.array(v.string()),
  files: v.record(v.string(), v.string()),
});
export type CompileRequest = v.InferOutput<typeof CompileRequestSchema>;

export const InitRequestSchema = v.object({ type: v.literal('init') });
/** Drop a queued compile (a job already running cannot be interrupted). */
export const CancelRequestSchema = v.object({ type: v.literal('cancel'), id: v.number() });

export const RequestSchema = v.variant('type', [
  InitRequestSchema,
  CompileRequestSchema,
  CancelRequestSchema,
]);
export type Request = v.InferOutput<typeof RequestSchema>;

export const ProgressSchema = v.object({
  type: v.literal('progress'),
  phase: v.picklist(['download', 'unpack', 'compile']),
  done: v.number(),
  total: v.number(),
});
export const ReadySchema = v.object({ type: v.literal('ready'), version: v.string() });
export const ResultSchema = v.object({
  type: v.literal('result'),
  id: v.number(),
  code: v.number(),
  stdout: v.string(),
  stderr: v.string(),
});
export const ErrorSchema = v.object({
  type: v.literal('error'),
  id: v.optional(v.number()),
  message: v.string(),
});

export const ResponseSchema = v.variant('type', [
  ProgressSchema,
  ReadySchema,
  ResultSchema,
  ErrorSchema,
]);
export type Response = v.InferOutput<typeof ResponseSchema>;
export type Progress = v.InferOutput<typeof ProgressSchema>;

export function parseRequest(data: unknown): Request | null {
  const r = v.safeParse(RequestSchema, data);
  return r.success ? r.output : null;
}
export function parseResponse(data: unknown): Response | null {
  const r = v.safeParse(ResponseSchema, data);
  return r.success ? r.output : null;
}
