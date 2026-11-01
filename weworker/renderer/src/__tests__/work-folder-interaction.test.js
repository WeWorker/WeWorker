import assert from 'node:assert/strict'
import test from 'node:test'

const interaction = await import('../utils/work-folder-interaction.js').catch(() => null)

function clickTarget(matchedSelector = '') {
  return {
    closest: (selectors) => selectors.includes(matchedSelector) && matchedSelector ? {} : null,
  }
}

test('clicking unused folder heading background toggles the folder', () => {
  assert.equal(typeof interaction?.handleFolderHeadingClick, 'function')
  let toggles = 0
  const handled = interaction.handleFolderHeadingClick({ target: clickTarget() }, () => { toggles += 1 })
  assert.equal(handled, true)
  assert.equal(toggles, 1)
})

test('clicking folder toggle or action controls does not trigger the heading background handler', () => {
  assert.equal(typeof interaction?.handleFolderHeadingClick, 'function')
  let toggles = 0
  const onToggle = () => { toggles += 1 }

  assert.equal(interaction.handleFolderHeadingClick({ target: clickTarget('.work-folder-heading__toggle') }, onToggle), false)
  assert.equal(interaction.handleFolderHeadingClick({ target: clickTarget('.work-folder-heading__actions') }, onToggle), false)
  assert.equal(toggles, 0)
})
