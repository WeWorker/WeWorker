/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * WeWorker modifications: v2 registration, host navigation, bounded runtime helpers, native input and local file I/O.
 * Rebuild: node webcli/scripts/opencli-xiaohongshu/build.mjs. See docs/opencli_xiaohongshu_migration.md. */
window.__webcliRegisterCommand("saved", params => window.__xhsOpenCLI.invoke("saved", params || {}));
