import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_WEEKDAYS, buildCron, getNextRuns, parseCron } from '../utils/scheduled-task-schedule.js'

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
