/** Legacy single fixtures remain valid; new suites are explicit and bounded. */
export function writeFixtureCases(fixture) {
  if (!fixture || !Object.hasOwn(fixture, 'cases')) return [fixture];
  if (Object.keys(fixture).join(',') !== 'cases' || !Array.isArray(fixture.cases) || fixture.cases.length < 2 || fixture.cases.length > 10
    || fixture.cases.some(value => !value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value,'cases'))
    || new Set(fixture.cases.map(value => value.id)).size !== fixture.cases.length) throw Object.assign(new Error('Declare 2–10 uniquely named write cases.'), {code:'INVALID_WRITE_CASE'});
  return fixture.cases;
}
