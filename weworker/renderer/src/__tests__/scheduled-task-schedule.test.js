import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_WEEKDAYS, buildCron, getNextRuns, parseCron, selectWeekdayPreset, toggleWeekday, WORKDAYS } from '../utils/scheduled-task-schedule.js'

test('weekday presets replace day selections and selecting a weekday clears the preset', () => {
  const initial = { weekdays: ALL_WEEKDAYS, weekdayPreset: 'every_day' }
  const workdays = selectWeekdayPreset(initial, 'workdays')
  assert.deepEqual(workdays.weekdays, WORKDAYS)
  assert.equal(workdays.weekdayPreset, 'workdays')

  const everyDay = selectWeekdayPreset(workdays, 'every_day')
  assert.deepEqual(everyDay.weekdays, ALL_WEEKDAYS)
  assert.equal(everyDay.weekdayPreset, 'every_day')

  const customDays = toggleWeekday(workdays, 5)
  assert.deepEqual(customDays.weekdays, [5])
  assert.equal(customDays.weekdayPreset, null)

  const addedDay = toggleWeekday(customDays, 1)
  assert.deepEqual(addedDay.weekdays, [1, 5])
  assert.equal(addedDay.weekdayPreset, null)
})

test('weekday preset selection restores from saved cron expressions', () => {
  assert.equal(parseCron('0 9 * * 1,2,3,4,5').weekdayPreset, 'workdays')
  assert.equal(parseCron('0 9 * * *').weekdayPreset, 'every_day')
  assert.equal(parseCron('0 9 * * 1,3,5').weekdayPreset, null)
})

for (const day of [0, 1, 2, 3, 4, 5, 6, 7]) {
  test(`weekly weekday ${day} restores its filter when a saved task is reopened`, () => {
    const normalizedDay = day % 7
    const saved = `0 9 * * ${day}`
    const reopened = parseCron(saved)
    assert.equal(reopened.frequency, 'weekly')
    assert.equal(reopened.weekday, String(normalizedDay))
    assert.deepEqual(reopened.weekdays, [normalizedDay])
    assert.equal(reopened.weekdayPreset, null)
    const savedAgain = buildCron(reopened)
    assert.equal(savedAgain, `0 9 * * ${normalizedDay}`)
    assert.deepEqual(parseCron(savedAgain).weekdays, [normalizedDay])
    const runs = getNextRuns(reopened, 3, new Date(2026, 10, 7, 12, 0))
    assert.deepEqual(runs.map(run => run.getDay()), [normalizedDay, normalizedDay, normalizedDay])
  })
}

test('weekly Tuesday and Wednesday selection survives save and reopen', () => {
  const weekly = { ...parseCron('0 9 * * *'), frequency: 'weekly' }
  const selected = toggleWeekday(toggleWeekday(weekly, 2), 3)
  assert.equal(buildCron(selected), '0 9 * * 2,3')
  const reopened = parseCron(buildCron(selected))
  assert.equal(reopened.frequency, 'weekly')
  assert.deepEqual(reopened.weekdays, [2, 3])
  assert.equal(reopened.weekdayPreset, null)
  assert.equal(buildCron(reopened), '0 9 * * 2,3')
})

test('weekly preview includes each selected day and advances past the current run', () => {
  const selected = { frequency: 'weekly', hour: 9, minute: 0, weekday: '1', weekdays: [2, 3], weekdayPreset: null }
  const runs = getNextRuns(selected, 4, new Date(2026, 10, 10, 9, 0, 0))
  assert.deepEqual(runs.map(run => [run.getMonth(), run.getDate(), run.getHours(), run.getMinutes()]), [
    [10, 11, 9, 0], [10, 17, 9, 0], [10, 18, 9, 0], [10, 24, 9, 0],
  ])
})

test('weekly custom days do not discard additional days when the dropdown day is included', () => {
  const selected = { frequency: 'weekly', hour: 0, minute: 0, weekday: '1', weekdays: [1, 2], weekdayPreset: null }
  assert.equal(buildCron(selected), '0 0 * * 1,2')
  assert.deepEqual(parseCron(buildCron(selected)).weekdays, [1, 2])
})

test('weekday filters become a cron weekday list and survive editing', () => {
  const schedule = {
    frequency: 'daily',
    hour: 9,
    minute: 30,
    weekdays: [1, 2, 3, 4, 5],
  }

  const cron = buildCron(schedule)
  assert.equal(cron, '30 9 * * 1,2,3,4,5')
  assert.deepEqual(parseCron(cron).weekdays, [1, 2, 3, 4, 5])
  assert.equal(buildCron({ ...schedule, weekdays: ALL_WEEKDAYS }), '30 9 * * *')
})

test('all supported frequency modes carry the selected weekday filter', () => {
  const weekdays = [1, 2, 3, 4, 5]
  assert.equal(buildCron({ frequency: 'every_n_minutes', minuteInterval: 15, weekdays }), '*/15 * * * 1,2,3,4,5')
  assert.equal(buildCron({ frequency: 'hourly', minute: 20, weekdays }), '20 * * * 1,2,3,4,5')
  assert.equal(buildCron({ frequency: 'weekly', weekday: '1', hour: 9, minute: 30, weekdays }), '30 9 * * 1')
  assert.equal(buildCron({ frequency: 'weekly', weekday: '6', hour: 9, minute: 30, weekdays }), '')
})

test('daily next-run preview skips excluded weekend days', () => {
  const fridayMorning = new Date(2026, 9, 30, 8, 0, 0)
  const runs = getNextRuns({
    frequency: 'daily',
    hour: 9,
    minute: 30,
    weekdays: [1, 2, 3, 4, 5],
  }, 3, fridayMorning)

  assert.deepEqual(runs.map((run) => run.getDay()), [5, 1, 2])
  assert.deepEqual(runs.map((run) => [run.getMonth(), run.getDate(), run.getHours(), run.getMinutes()]), [
    [9, 30, 9, 30],
    [10, 2, 9, 30],
    [10, 3, 9, 30],
  ])
})

test('weekly mode has no upcoming runs when its selected weekday is filtered out', () => {
  const runs = getNextRuns({
    frequency: 'weekly',
    weekday: '0',
    hour: 9,
    minute: 30,
    weekdays: [1, 2, 3, 4, 5],
  })
  assert.deepEqual(runs, [])
})
