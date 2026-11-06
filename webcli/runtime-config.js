import defaults from './runtime-config.json' with { type: 'json' };
export const runtimeConfig = typeof __WEBCLI_RUNTIME_CONFIG__ === 'undefined' ? defaults : __WEBCLI_RUNTIME_CONFIG__;
