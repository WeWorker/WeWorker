import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectLocalUpload } from './upload-files.js';

const run = promisify(execFile);
const fail = (code, message) => { throw Object.assign(new Error(message), {code, details:{dispatched:false}}); };
// Use the same company-supported utility as check_file_encryption/decrypt_file.
// Never read/copy plaintext or infer encryption from a size discrepancy.
export async function prepareUploadFiles(paths, directory = false, options = {}) {
  const entries = inspectLocalUpload(paths, directory, {metadataOnly:true});
  const platform = options.platform ?? process.platform;
  const resources = options.resourcesPath ?? process.env.WEWORKER_RESOURCES_PATH;
  const exe = resources ? path.join(resources, 'tools', 'sd_decrypt.exe') : null;
  let checked = 0, decrypted = 0;
  if (platform === 'win32' && exe && fs.existsSync(exe)) {
    const invoke = async (args, timeout) => {
      try {
        const {stdout} = await (options.run ?? run)(exe, args, {timeout, windowsHide:true, encoding:'utf8', maxBuffer:1024*1024});
        const result = JSON.parse(stdout.trim());
        if (result.success !== true) throw new Error('Utility failed');
        return result;
      } catch { fail('UPLOAD_ENCRYPTION_FAILED', 'File encryption preparation failed; no upload started. Check the company decryption utility. Do not copy or retry the file automatically.'); }
    };
    for (let i=0; i<entries.length; i++) {
      const file = directory ? path.join(path.dirname(paths[0]), entries[i].relativePath) : paths[i];
      const check = async () => {
        const r = await invoke(['--check','--json',file],15000);
        if (r.encryption_status === 'encrypted' && r.encrypted === true) return true;
        if (r.encryption_status === 'not_encrypted' && r.encrypted === false) return false;
        fail('UPLOAD_ENCRYPTION_UNKNOWN','Cannot determine file encryption state; no upload started.');
      };
      checked++;
      if (await check()) {
        await invoke(['--json',file],60000);
        if (await check()) fail('UPLOAD_DECRYPTION_INCOMPLETE','The file is still encrypted after decryption; no upload started.');
        decrypted++;
      }
    }
  }
  // Reinspect the actual path after decryption. Keep identity, type and size
  // protections; a remaining discrepancy is not permission to bypass DLP.
  return {files:inspectLocalUpload(paths,directory), preparation:{checked,decrypted,method:checked?'company-decrypt-tool':'ordinary-file-check'}};
}
