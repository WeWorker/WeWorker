/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/article.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page navigation through the host resume protocol.
 * The source declares an INTERCEPT strategy but only reads rendered DOM, so no
 * network capture is used. The source's 800-character body cap is preserved
 * and made explicit: body_length/body_truncated/content_status describe what
 * was actually extracted, and the full article is never claimed to be returned.
 * Arbitrary digit-stripping of non-URL input is not kept: ids must be numeric
 * or come from a 36kr.com /p/ URL. */
(function () {
  __webcliRegisterCommand('article', async (args = {}) => {
    const api = window.__kr36;
    const articleId = api.parseArticleId(args.id);
    if (!articleId) {
      throw new api.ArgumentError('Invalid article ID or URL; pass a numeric 36kr article id or an https://www.36kr.com/p/<id> URL (the whole path must be /p/<digits>)');
    }
    const target = 'https://www.36kr.com/p/' + articleId;
    if (!api.same(target)) return api.navigate(target);
    api.guard();
    const rendered = await api.waitFor(async () =>
      Boolean(document.querySelector('.article-title, h1, [class*="article-content"], [class*="rich-text"]')));
    if (!rendered) {
      throw new api.CommandExecutionError('36kr article page did not render within the wait budget', 'Check the article ID');
    }
    const title = document.querySelector('.article-title, h1')?.textContent?.trim() || '';
    /* Author: first non-empty .author-name (source comment: the nav link is empty). */
    const authorEls = document.querySelectorAll('.author-name');
    const author = Array.from(authorEls).map((el) => el.textContent?.trim()).filter(Boolean)[0] || '';
    /* Date: 36kr uses class "title-icon-item item-time" for the publish date. */
    const dateRaw = document.querySelector('.item-time')?.textContent?.trim() || '';
    const date = dateRaw.replace(/^[·\s]+/, '').trim();
    const bodyEls = document.querySelectorAll('[class*="article-content"] p, [class*="rich-text"] p, .article p');
    const fullText = Array.from(bodyEls)
      .map((el) => el.textContent?.trim())
      .filter((text) => text && text.length > 10)
      .join(' ');
    if (!title) {
      throw new api.EmptyResultError('36kr article not found or failed to load', 'Check the article ID');
    }
    if (!fullText) {
      throw new api.CommandExecutionError('36kr article body not found', 'The page loaded but no article body paragraphs were extracted');
    }
    const truncated = fullText.length > api.ARTICLE_BODY_MAX_CHARS;
    return [
      { field: 'title', value: title },
      { field: 'author', value: author || '' },
      { field: 'date', value: date || '' },
      { field: 'url', value: 'https://www.36kr.com/p/' + articleId },
      { field: 'body', value: fullText.slice(0, api.ARTICLE_BODY_MAX_CHARS) },
      { field: 'body_length', value: fullText.length },
      { field: 'body_truncated', value: truncated },
      {
        field: 'content_status',
        value: truncated
          ? 'partial: first ' + api.ARTICLE_BODY_MAX_CHARS + ' characters of the extracted page text; the full article is not returned by this command, open url for the complete content'
          : 'extracted page text within the ' + api.ARTICLE_BODY_MAX_CHARS + '-character cap; completeness is not guaranteed, open url to verify',
      },
    ];
  });
})();
