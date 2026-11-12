/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;
const run=async (kwargs) => {

        verbose('Fetching job statistics...');
        const filterJobId = kwargs['job-id'] || '';

        // Get job list
        const jobData = await bossFetch('https://www.zhipin.com/wapi/zpjob/job/chatted/jobList');
        // Get total chat stats (non-critical, allow failure)
        const chatStats = await bossFetch('https://www.zhipin.com/wapi/zpchat/chatHelper/statistics', {
            allowNonZero: true,
        });
        const totalFriends = chatStats.code === 0 && Number.isFinite(chatStats.zpData?.totalFriendCount) ? chatStats.zpData.totalFriendCount : null;
        // Get per-job chat counts from friend list (non-critical)
        let friendList = []; let sampleAvailable = false;
        try {
            friendList = await fetchFriendList(); sampleAvailable = true;
        }
        catch { /* ignore */ }
        const jobChatCounts = {};
        for (const f of friendList) {
            const jobName = f.jobName || 'unknown';
            jobChatCounts[jobName] = (jobChatCounts[jobName] || 0) + 1;
        }
        if (!Array.isArray(jobData.zpData)) throw new CommandExecutionError('BOSS job list missing');
        let jobs = jobData.zpData;
        if (filterJobId) {
            jobs = jobs.filter((j) => j.encryptJobId === filterJobId);
        }
        const results = jobs.map((j) => ({
            result_id: j.encryptJobId ? 'job:' + j.encryptJobId : null,
            followup_job_id: j.encryptJobId || null,
            job_name: j.jobName || '',
            salary: j.salaryDesc || '',
            city: j.address || '',
            status: j.jobOnlineStatus === 1 ? '在线' : '已关闭',
            total_chats: null,
            sampled_chats: sampleAvailable ? (jobChatCounts[j.jobName] ?? 0) : null,
            count_scope: 'first_friend_page_grouped_by_job_name_not_total',
            encrypt_job_id: j.encryptJobId || '',
        }));
        if (!filterJobId && results.length > 0) {
            results.push({
                result_id: 'summary',
                followup_job_id: null,
                job_name: '--- 总计 ---',
                salary: '',
                city: '',
                status: `${jobs.length} 个职位`,
                total_chats: totalFriends,
                count_scope: 'account_friend_count_not_per_job_chat_count',
                encrypt_job_id: '',
            });
        }
        return results;
    };
__webcliRegisterCommand("stats",async(args={})=>{args={...{"job-id":""},...args};if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/'))return navigate('https://www.zhipin.com/web/chat/index');guard();return run(args);});})();
