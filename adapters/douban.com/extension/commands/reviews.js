/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bool,loadDocument,getSelfUid,normalizeDoubanSubjectId,loadDoubanSubjectDetail,loadDoubanSubjectPhotos,loadDoubanBookHot,loadDoubanMovieHot,searchDouban}=window.__douban;async function fetchReviews(uid, limit, full) {
    const reviews = [];
    let start = 0;
    const pageSize = 20;
    while (true) {if(start>=1500)throw new CommandExecutionError('Pagination exceeded the 1500-row safety bound; narrow the request');
        const url = `https://movie.douban.com/people/${uid}/reviews?start=${start}&sort=time`;
        const document=await loadDocument(url);

        const data = await (
      () => {
        const reviews = [];

        document.querySelectorAll('.tlst').forEach(el => {
          const movieLinkEl = el.querySelector('.ilst a');
          const reviewTitleEl = el.querySelector('.nlst a[title]');
          const ratingEl = el.querySelector('.clst span[class*="allstar"]');
          const contentEl = el.querySelector('.review-short span');
          const votesEl = el.querySelector('.review-short .pl span');

          const movieHref = movieLinkEl?.href || '';
          const movieId = movieHref.match(/subject\/(\d+)/)?.[1] || '';
          const movieTitle = movieLinkEl?.getAttribute('title') || movieLinkEl?.textContent?.trim() || '';

          const reviewHref = reviewTitleEl?.href || '';
          const reviewId = reviewHref.match(/reviews?\/(\d+)/)?.[1] || '';
          const title = reviewTitleEl?.textContent?.trim() || '';

          let myRating = 0;
          if (ratingEl) {
            const cls = ratingEl.className || '';
            const ratingMatch = cls.match(/allstar(\d)0/);
            if (ratingMatch) {
              myRating = parseInt(ratingMatch[1], 10) * 2;
            }
          }

          const votesText = votesEl?.textContent || '';
          const votesMatch = votesText.match(/(\d+)/);
          const votes = votesMatch ? parseInt(votesMatch[1], 10) : 0;

          reviews.push({
            reviewId,
            movieId,
            movieTitle,
            title,
            content: contentEl?.textContent?.trim() || '',
            myRating,
            createdAt: '',
            votes,
            url: reviewHref,
          });
        });

        return reviews;
      }
    )();
        reviews.push(...data);
        if (data.length < pageSize)
            break;
        if (limit > 0 && reviews.length >= limit)
            break;
        start += pageSize;
    }
    const result = reviews.slice(0, limit > 0 ? limit : undefined);
    if (full && result.length > 0) {
        for (const review of result) {
            if (review.url) {
                const fullContent = await fetchFullReview(review.url);
                review.content = fullContent;
            }
        }
    }
    return result;
}
async function fetchFullReview(reviewUrl) {
    const document=await loadDocument(reviewUrl);

    const content = await (
    () => {
      const contentEl = document.querySelector('.review-content');
      return contentEl?.textContent?.trim() || '';
    }
  )();
    return content;
}
const run=async (kwargs={}) => {
        const { limit = 20, uid: providedUid, full = false } = kwargs;
        const uid = providedUid || await getSelfUid();
        const reviews = await fetchReviews(uid, limit, full);
        return reviews;
    };__webcliRegisterCommand("reviews",async(params={})=>{const values={...{"limit":20,"full":false},...params};values.limit=integer(values.limit,20,1500);values.full=bool(values.full);if(values.uid!==undefined&&!/^[A-Za-z0-9_-]+$/.test(values.uid))throw new ArgumentError('Invalid uid');if(location.hostname!=='movie.douban.com')return navigate('https://movie.douban.com/');guard();const result=await run(values);if(Array.isArray(result)&&!result.length)throw new CommandExecutionError("No data extracted; empty result versus page failure is unknown");return result;});})();
