/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, clis/github-trending/repos.js.
 * Apache-2.0, Copyright 2025 jackwener. Modified: bounded restricted background fetch, strict arguments, period verification and safe counts. */
(function () {
class CommandExecutionError extends Error { constructor(message) { super(message); this.code = 'PARSE_ERROR'; } }
function decodeHtmlEntities(value) {
    return String(value ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
    return String(value ?? '').replace(/<[^>]*>/g, '');
}

function parseCount(value) {
    if (value == null) return null;
    const digits = String(value).replace(/[,\s]/g, '');
    if (!/^\d+$/.test(digits)) return null;
    const count = Number(digits); return Number.isSafeInteger(count) ? count : null;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertCount(value, field, repo) {
    const count = parseCount(value);
    if (count == null) {
        throw new CommandExecutionError(`github-trending parser drift: missing ${field} for ${repo}`);
    }
    return count;
}

function hasExplicitEmptyTrending(html) {
    return /don.t have any trending repositories/i.test(stripTags(html))
        || /no trending repositories/i.test(stripTags(html));
}

function parseTrendingHtml(html, limit) {
    const blocks = Array.from(String(html ?? '').matchAll(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g))
        .map((match) => match[1]);
    const rows = [];

    if (blocks.length === 0) {
        if (hasExplicitEmptyTrending(html)) return rows;
        throw new CommandExecutionError('github-trending parser drift: no repository rows found');
    }

    for (const raw of blocks) {
        const block = raw;

        const nameMatch = block.match(/<h2\b[\s\S]*?href="\/([^"/?#]+\/[^"/?#]+)"/);
        if (!nameMatch) {
            throw new CommandExecutionError('github-trending parser drift: missing repository link');
        }
        const repo = decodeHtmlEntities(nameMatch[1]).trim();
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
            throw new CommandExecutionError(`github-trending parser drift: invalid repository identity "${repo}"`);
        }

        const descMatch = block.match(/<p class="col-9 color-fg-muted[^"]*">([\s\S]*?)<\/p>/);
        const description = descMatch
            ? decodeHtmlEntities(stripTags(descMatch[1]).replace(/\s+/g, ' ')).trim()
            : '';

        const langMatch = block.match(/<span itemprop="programmingLanguage">([\s\S]*?)<\/span>/);
        const language = langMatch ? decodeHtmlEntities(stripTags(langMatch[1])).trim() : null;

        const escapedRepo = escapeRegExp(repo);
        const starsMatch = block.match(new RegExp(`<a\\b[^>]*href="/${escapedRepo}/stargazers"[^>]*>([\\s\\S]*?)</a>`));
        const forksMatch = block.match(new RegExp(`<a\\b[^>]*href="/${escapedRepo}/forks"[^>]*>([\\s\\S]*?)</a>`));
        const sinceMatch = block.match(/([\d,]+)\s+stars\s+(?:today|this week|this month)/i);

        rows.push({
            repo,
            description,
            language,
            stars: assertCount(starsMatch ? stripTags(starsMatch[1]) : null, 'stars', repo),
            forks: assertCount(forksMatch ? stripTags(forksMatch[1]) : null, 'forks', repo),
            starsSince: assertCount(sinceMatch?.[1], 'period stars', repo),
            url: `https://github.com/${repo}`,
        });
        if (rows.length >= limit) break;
    }
    return rows;
}

window.__githubTrending = { parseTrendingHtml };
})();
