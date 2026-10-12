/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2: restricted fetch, bounded navigation continuation, declarative pipeline executor, validated inputs and explicit parse failures.
 * Rebuild: node webcli/scripts/opencli-wave5/build.mjs */
window.__webcliRegisterCommand("login", args => window.__wave5.invoke("v2ex/login", args || {}));
