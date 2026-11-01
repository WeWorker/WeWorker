import { GITHUB_RELEASES } from './siteConfig.js'

/**
 * 对外版：安装包从 GitHub Releases 获取。
 * 文档内 download-cards 组件仍展示平台说明，点击跳转 Releases。
 */
export const APP_VERSION = '1.0.1'

export const DOWNLOAD_REPORT_URL = ''

export const DOWNLOAD_SUMMARY_URL = ''

const releaseAssetUrl = (filename) => `${GITHUB_RELEASES}/latest/download/${filename}`

export const DOWNLOADS = [
  {
    id: 'windows',
    title: 'Windows 下载',
    subtitle: 'Windows 10 / 11（x64）',
    filename: `WeWorker-${APP_VERSION}-win-x64.exe`,
    href: releaseAssetUrl(`WeWorker-${APP_VERSION}-win-x64.exe`),
    icon: 'windows',
    platform: 'win-x64',
  },
  {
    id: 'mac-intel',
    title: 'Mac Intel 下载',
    subtitle: 'Intel 芯片（x64）',
    filename: `WeWorker-${APP_VERSION}-mac-x64.dmg`,
    href: releaseAssetUrl(`WeWorker-${APP_VERSION}-mac-x64.dmg`),
    icon: 'mac',
    platform: 'mac-x64',
  },
  {
    id: 'mac-apple',
    title: 'Mac Apple 下载',
    subtitle: 'Apple 芯片（M 系列）',
    filename: `WeWorker-${APP_VERSION}-mac-arm64.dmg`,
    href: releaseAssetUrl(`WeWorker-${APP_VERSION}-mac-arm64.dmg`),
    icon: 'mac',
    platform: 'mac-arm64',
  },
]
