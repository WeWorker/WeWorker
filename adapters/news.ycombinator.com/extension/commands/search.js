/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/hackernews/search.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2 background API execution; query/tags are strictly
 * URL-encoded through URLSearchParams instead of loose template interpolation. */
(function () {
  __webcliRegisterCommand('search', async (args = {}) => {
    const api = window.__hackernews;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new api.ArgumentError('query must be a non-empty string');
    const limit = api.integerArg('limit', args.limit, 20, 1, 100);
    const sort = args.sort === undefined || args.sort === null ? 'relevance' : args.sort;
    if (sort !== 'relevance' && sort !== 'date') {
      throw new api.ArgumentError('sort must be one of: relevance, date');
    }
    return api.algoliaSearch(query, limit, sort);
  });
})();
