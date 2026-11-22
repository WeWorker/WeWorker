/**
 * 发票原件 PDF 文本提取（costplus adapter internal）聚焦测试。
 *
 * 用合成 PDF 覆盖三类可解码字体：
 * - 无 ToUnicode + UniGB-UCS2-H（开票软件常见：双字节码即 Unicode）
 * - 无 ToUnicode + WinAnsiEncoding（信用代码的 ASCII 数字字母）
 * - 带 ToUnicode 的子集字体（2 字节与 1 字节 codespacerange 两种码宽）
 *
 * legacy.js 是打包进扩展的运行时代码（非 ESM），这里按函数标记提取后求值，
 * 与生产实现保持同源。测试数据全部为合成占位值，不含真实发票。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const legacySource = fs.readFileSync(
  path.resolve(__dirname, '../../../../adapters/costplus.weoa.com/extension/internal/legacy.js'),
  'utf8',
)

const blockBetween = (start: string, end: string): string => {
  const s = legacySource.indexOf(start)
  const e = legacySource.indexOf(end, s)
  if (s < 0 || e < 0) throw new Error(`legacy.js marker missing: ${start}`)
  return legacySource.slice(s, e)
}

const parserSource = blockBetween('function extractPdfLiteralStrings', 'async function parsePdfTextLines')
  + blockBetween('async function parsePdfTextLines', 'async function fetchInvoiceTaxNumbers')

// eslint-disable-next-line no-new-func
const { parsePdfTextLines, extractInvoiceCreditCodes } = new Function(
  'createCostplusError',
  `${parserSource}\n return { parsePdfTextLines, extractInvoiceCreditCodes }`,
)((_code: string, message: string) => new Error(message)) as {
  parsePdfTextLines: (bytes: Uint8Array) => Promise<string[]>
  extractInvoiceCreditCodes: (lines: string[]) => { purchaserTaxNo: string; sellerTaxNo: string }
}

/** 合成统一社会信用代码：按 GB 32100-2015 计算校验位（占位数据，本体需 17 位）。 */
const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY'
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]
function syntheticUscc(body17: string): string {
  if (body17.length !== 17) throw new Error(`USCC body must be 17 chars, got ${body17.length}`)
  let sum = 0
  for (let i = 0; i < 17; i++) sum += USCC_CHARSET.indexOf(body17[i]) * USCC_WEIGHTS[i]
  return body17 + USCC_CHARSET[(31 - (sum % 31)) % 31]
}

const ucs2 = (text: string): string => {
  let out = ''
  for (const ch of text) out += String.fromCharCode(ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff)
  return out
}

function pdfObject(num: number, dict: string, stream?: string): string {
  if (stream === undefined) return `${num} 0 obj\n<<${dict}>>\nendobj\n`
  const data = zlib.deflateSync(Buffer.from(stream, 'latin1'))
  const body = Array.from(data, (b) => String.fromCharCode(b)).join('')
  return `${num} 0 obj\n<<${dict} /Length ${data.length}>>\nstream\n${body}\nendstream\nendobj\n`
}

function buildSamplePdf(purchaser: string, seller: string): Uint8Array {
  const content = [
    '/Xi0 10 Tf',
    `(${ucs2('购买方名称占位')})Tj`,
    '/Xi1 10 Tf',
    `(${purchaser})Tj`,
    '/Xi0 10 Tf',
    `(${ucs2('销售方名称占位')})Tj`,
    '/Xi1 10 Tf',
    `(${seller})Tj`,
    '/TT0 10 Tf',
    '<1234>Tj',
    '/TT1 10 Tf',
    '<21>Tj',
  ].join('\n')
  const cmapTwoByte = [
    '/CIDInit /ProcSet findresource begin',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '1 beginbfrange',
    '<1234> <1234> <5168>',
    'endbfrange',
    'endcmap',
  ].join('\n')
  const cmapOneByte = [
    '/CIDInit /ProcSet findresource begin',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '1 beginbfchar',
    '<21> <9879>',
    'endbfchar',
    'endcmap',
  ].join('\n')
  const pdf = [
    '%PDF-1.7',
    pdfObject(1, ' /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [8 0 R]'),
    pdfObject(2, ' /Type /Font /Subtype /TrueType /BaseFont /Courier /Encoding /WinAnsiEncoding'),
    pdfObject(3, ' /Type /Page /Resources << /Font << /Xi0 1 0 R /Xi1 2 0 R /TT0 4 0 R /TT1 6 0 R >> >>'),
    pdfObject(4, ' /Type /Font /Subtype /Type0 /BaseFont /SubsetA /Encoding /Identity-H /ToUnicode 5 0 R /DescendantFonts [8 0 R]'),
    pdfObject(5, ' ', cmapTwoByte),
    pdfObject(6, ' /Type /Font /Subtype /Type0 /BaseFont /SubsetB /Encoding /Identity-H /ToUnicode 7 0 R /DescendantFonts [8 0 R]'),
    pdfObject(7, ' ', cmapOneByte),
    pdfObject(9, ' /Type /Page /Contents 9 0 R', content),
    '%%EOF',
  ].join('\n')
  return new Uint8Array(Array.from(Buffer.from(pdf, 'latin1')))
}

describe('costplus invoice PDF text extraction', () => {
  it('decodes UniGB-UCS2 and WinAnsi fonts without ToUnicode maps', async () => {
    const purchaser = syntheticUscc('12345678901234567')
    const seller = syntheticUscc('ABCDEFGHJKLMNPQRT')
    const lines = await parsePdfTextLines(buildSamplePdf(purchaser, seller))
    // 中文走 UniGB-UCS2-H 双字节直读
    expect(lines.some((line) => line.includes('购买方名称占位'))).toBe(true)
    expect(lines.some((line) => line.includes('销售方名称占位'))).toBe(true)
    // 信用代码走 WinAnsi ASCII 直读，顺序保持 购买方在前
    const codes = extractInvoiceCreditCodes(lines)
    expect(codes).toEqual({ purchaserTaxNo: purchaser, sellerTaxNo: seller })
  })

  it('keeps ToUnicode decoding for subset fonts with both code widths', async () => {
    const purchaser = syntheticUscc('12345678901234567')
    const seller = syntheticUscc('ABCDEFGHJKLMNPQRT')
    const lines = await parsePdfTextLines(buildSamplePdf(purchaser, seller))
    // 2 字节码宽：<1234> → 全（bfrange 目标 U+5168）
    expect(lines.some((line) => line.includes('全'))).toBe(true)
    // 1 字节码宽：<21> → 项（bfchar 目标 U+9879；此前固定 4 位步长会解错）
    expect(lines.some((line) => line.includes('项'))).toBe(true)
  })

  it('throws when no decodable text mapping exists at all', async () => {
    const bare = new Uint8Array(Array.from(Buffer.from(
      `%PDF-1.7\n${pdfObject(1, ' /Type /Font /Subtype /Type0 /BaseFont /Broken /Encoding /Identity-H')}\n%%EOF`,
      'latin1',
    )))
    await expect(parsePdfTextLines(bare)).rejects.toThrow(/无法提取文本/)
  })
})
