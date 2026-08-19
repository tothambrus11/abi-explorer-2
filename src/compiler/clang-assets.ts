// Identity of the clang bundle, shared by the worker (which downloads it) and
// the main thread (which checks whether it is already local before prompting).

export const CLANG_VERSION = '22.0.0-git20542-10';
export const CLANG_TARBALL_URL = `https://registry.npmjs.org/@yowasp/clang/-/clang-${CLANG_VERSION}.tgz`;
export const CLANG_CACHE_NAME = 'abix-clang-' + CLANG_VERSION;
