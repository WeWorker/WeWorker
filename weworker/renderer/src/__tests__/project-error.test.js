import test from 'node:test'
import assert from 'node:assert/strict'
import { projectErrorMessage } from '../utils/project-error.js'

test('duplicate workspace names and folders have actionable messages', () => {
  assert.equal(projectErrorMessage('UNIQUE constraint failed: projects.name'), '已存在同名工作区，请换一个名称。')
  assert.equal(projectErrorMessage('project folder already exists'), '工作区文件夹已存在，请换一个名称或选择其他文件夹。')
})

test('preserves other errors and uses fallback for missing or invalid details', () => {
  assert.equal(projectErrorMessage('名称不能为空', '创建失败'), '名称不能为空')
  for (const detail of [undefined, null, '', {}, []]) {
    assert.equal(projectErrorMessage(detail, '创建失败'), '创建失败')
  }
})
