import test from 'node:test'
import assert from 'node:assert/strict'
import { isTabTableBlock, preChildText } from '../utils/code-block.js'

test('isTabTableBlock marks tab-separated table blocks only', () => {
  assert.equal(isTabTableBlock('发票号码\t销方识别号\t销方名称\t购买方名称'), true, 'TSV rows are tables')
  assert.equal(isTabTableBlock('header\ta\tb\tc\nrow1\t1\t2\t3'), true, 'multi-line TSV is a table')
  assert.equal(isTabTableBlock('a\tb'), false, 'two columns are too few (could be inline tab usage)')
  assert.equal(isTabTableBlock('const a = 1;\nconsole.log(a);'), false, 'plain code keeps default rendering')
  assert.equal(isTabTableBlock('  indented code'), false, 'spaces alone are not a table')
  assert.equal(isTabTableBlock('if (x) {\n\treturn 1\n}'), false, 'single tab indent is not a table')
  assert.equal(isTabTableBlock(''), false)
  assert.equal(isTabTableBlock(null), false)
  assert.equal(isTabTableBlock(undefined), false)
})

test('preChildText extracts the code text from react-markdown pre children', () => {
  assert.equal(preChildText({ props: { children: 'a\tb' } }), 'a\tb', 'single code element')
  assert.equal(preChildText([{ props: { children: 'a b' } }, 'extra']), 'a b', 'array children use the first element')
  assert.equal(preChildText('raw text'), 'raw text', 'string children pass through')
  assert.equal(preChildText({ props: { children: ['nested', 'array'] } }), '', 'non-string inner content is ignored')
  assert.equal(preChildText(null), '')
  assert.equal(preChildText(undefined), '')
})
