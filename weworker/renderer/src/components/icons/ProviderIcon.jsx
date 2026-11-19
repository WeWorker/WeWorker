import React from 'react'
import { Building2, CircleCheck, Layers } from 'lucide-react'
import glmIcon from '../../assets/provider-icons/zhipu-color.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek-color.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import qwenIcon from '../../assets/provider-icons/qwen-color.svg'

const BRAND_ICONS = { glm: glmIcon, deepseek: deepseekIcon, qwen: qwenIcon }

export default function ProviderIcon({ provider, size = 20 }) {
  const style = { width: size, height: size, flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }
  if (BRAND_ICONS[provider]) return <img src={BRAND_ICONS[provider]} alt="" aria-hidden="true" style={{ ...style, objectFit: 'contain' }} />
  if (provider === 'openai') return <span aria-hidden="true" style={{ ...style, backgroundColor: 'currentColor', mask: `url(${openaiIcon}) center / contain no-repeat`, WebkitMask: `url(${openaiIcon}) center / contain no-repeat` }} />
  const Icon = provider === 'bank_coding' ? Building2 : provider?.startsWith('builtin') ? CircleCheck : Layers
  return <Icon size={size} aria-hidden="true" style={{ flexShrink: 0, verticalAlign: 'middle' }} />
}
