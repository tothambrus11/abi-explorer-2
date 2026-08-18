// Monaco 0.56 ships types for its package root only; the sub-path entry points
// we use resolve to the same API surface.
declare module 'monaco-editor/editor/editor.api.js' {
  export * from 'monaco-editor';
}
declare module 'monaco-editor/languages/definitions/cpp/register.js';
declare module 'monaco-editor/editor/browser/*';
declare module 'monaco-editor/editor/contrib/*';
declare module 'monaco-editor/editor/standalone/*';
declare module 'monaco-editor/editor/common/*';
declare module 'monaco-editor/base/browser/*';
declare module 'monaco-editor/editor/editor.worker.js?worker' {
  const WorkerCtor: new () => Worker;
  export default WorkerCtor;
}
