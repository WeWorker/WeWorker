/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2: restricted fetch, navigation continuation, validated inputs and explicit parse failures.
 * Rebuild: node webcli/scripts/opencli-wave4/build.mjs */
window.__webcliRegisterCommand("login", args => window.__wave4.invoke("toutiao/login", args || {}));
