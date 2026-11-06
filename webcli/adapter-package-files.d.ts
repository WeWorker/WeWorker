import type { V2Package } from './adapter-catalog.js'
export function readPackageDirectory(root: string): V2Package
export function validatePackageFiles(files: Map<string, Buffer | string>): V2Package
