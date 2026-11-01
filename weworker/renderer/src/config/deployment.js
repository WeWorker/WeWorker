// Vite injects a serializable deployment snapshot at build time. Avoid importing
// CommonJS deployment configuration directly into the browser bundle.
export const deploymentConfig = __BUILD_DEPLOYMENT_CONFIG__

export default deploymentConfig
