import rawDeployment from '../../../deployment.json' with { type: 'json' }
import deploymentConfigModule from '../../../deployment-config.cjs'

export const deploymentConfig = deploymentConfigModule.normalizeDeploymentConfig(rawDeployment)

export default deploymentConfig
