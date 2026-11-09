/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,WE_ORIGIN,JOBS_ORIGIN,SALARY_CODES,WORKYEAR_CODES,DEGREE_CODES,COMPANY_TYPE_CODES,COMPANY_SIZE_CODES,SORT_CODES,buildSearchUrl,mapJobItem,resolveCity,resolveCode,parseCompanyJobCard,pageFetchJson,integer,navigate,same,guard}=window.__job51;__webcliRegisterCommand("company",async (kwargs={}) => {

        const encCoId = String(kwargs.encCoId ?? '').trim();
        if (!encCoId) throw new CliError('INVALID_ARGUMENT', 'encCoId is required');
        if (!/^[A-Za-z0-9_=-]+$/.test(encCoId)) {
            throw new CliError('INVALID_ARGUMENT', `encCoId must be alphanumeric/underscore, got "${encCoId}"`);
        }
        const limit = integer(kwargs.limit,20,50);

        const url = `${JOBS_ORIGIN}/all/co${encodeURIComponent(encCoId)}.html`;
        if (!same(url)) return navigate(url); guard();

        const extract = () => ((() => {
            const sel = s => document.querySelector(s)?.innerText?.trim() || '';
            const bodyText = (document.body.innerText || '').slice(0, 400);
            if (/公司不存在|页面不存在|账号状态异常/.test(bodyText)) {
                return { error: 'NOT_FOUND', bodyText };
            }
            const companyName = sel('h1') || sel('.cname');
            // Company introduction block
            const introEl = document.querySelector('#companyIntroRef, .c-intro');
            const companyIntro = introEl ? (introEl.innerText || '').trim() : '';
            // Info sidebar (type / size / industry) — labels sit in .com-info dl or .coinfo
            const sidebarText = sel('.ci-content, .company-info, .coinfo, .com-info');
            const links = [...document.querySelectorAll('a[sensorsdata]')]
                .filter(a => /\/\d{6,}\.html/.test(a.href || ''))
                .slice(0, 60)
                .map(a => {
                    return {
                        href: a.href,
                        sensorsdata: a.getAttribute('sensorsdata') || '',
                        text: (a.innerText || '').trim(),
                    };
                });
            // Company meta is three inline spans under .c-info.ellipsis
            // (title/size/industry) — extract them by position.
            const cInfo = document.querySelector('.c-info.ellipsis');
            const cInfoParts = cInfo
                ? [...cInfo.querySelectorAll('span')].map(s => (s.innerText || '').trim()).filter(Boolean)
                : [];
            return {
                companyName,
                companyIntro,
                links,
                cInfoParts,
                sidebarText: sidebarText.slice(0, 400),
            };
        })());
        const data = extract();
        if (data.error === 'NOT_FOUND') {
            throw new CliError('NO_DATA', `Company ${encCoId} not found`);
        }
        if (!data.companyName) {
            throw new CliError('PARSE_ERROR', `Could not parse company page ${encCoId}; layout may have changed`);
        }

        const companyUrl = url;
        const [companyType = '', companySize = '', companyIndustry = ''] = data.cInfoParts || [];

        const seen = new Set();
        const rows = [];
        for (const link of data.links || []) {
            const job = parseCompanyJobCard(link);
            if (!job) continue;
            if (seen.has(job.jobId)) continue;
            seen.add(job.jobId);
            rows.push({
                rank: rows.length + 1,
                ...job,
                resultId: job.jobId,
                resultTitle: job.title,
                companyName: data.companyName,
                companyType,
                companySize,
                companyIndustry,
                companyIntro: data.companyIntro || '',
                companyUrl,
            });
            if (rows.length >= limit) break;
        }
        if (rows.length === 0) {
            // Still return a sentinel row with the company info so caller isn't left with [].
            return [{
                rank: 0,
                jobId: '',
                resultId: `company:${encCoId}`,
                resultTitle: data.companyName,
                title: null, extraction_status: 'no_job_cards', note: '未取得职位卡片，不能据此推断没有在招职位',
                salary: '', city: '', workYear: '', degree: '',
                funcType: '', issueDate: '', url: '',
                companyName: data.companyName,
                companyType, companySize, companyIndustry,
                companyIntro: data.companyIntro || '',
                companyUrl,
            }];
        }
        return rows;
    });})();
