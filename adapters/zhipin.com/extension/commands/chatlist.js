/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;function formatMsgTime(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleString('zh-CN');
}
function mapBossRow(f) {
    return {
        identity_side: 'boss',
        name: f.name || '',
        company: '',
        job: f.jobName || '',
        title: '',
        last_msg: f.lastMessageInfo?.text || '',
        last_time: f.lastTime || '',
        uid: f.encryptUid || '',
        security_id: f.securityId || '',
    };
}
async function buildGeekRows(limit) {
    const encryptSystemId = await readEncryptSystemId();
    const labelList = await fetchGeekFriendLabelList({ encryptSystemId });
    if (labelList.length === 0) {
        return [];
    }
    const slicedLabels = labelList.slice(0, limit);
    const friendIds = slicedLabels.map((f) => f.friendId).filter(Boolean);
    const enriched = await fetchGeekFriendInfoList(friendIds);
    const enrichMap = new Map(enriched.map((f) => [String(f.friendId ?? f.uid), f]));
    return slicedLabels.map((f) => {
        const e = enrichMap.get(String(f.friendId)) || {};
        return {
            identity_side: 'geek',
            name: e.name || f.name || '',
            company: e.brandName || f.brandName || '',
            job: e.jobName || f.jobName || '',
            title: e.bossTitle || f.bossTitle || '',
            last_msg: e.lastMessageInfo?.showText || e.lastMsg || f.lastMsg || '',
            last_time: e.lastTime || formatMsgTime(e.lastMessageInfo?.msgTime) || formatMsgTime(f.updateTime) || '',
            uid: e.encryptUid || f.encryptFriendId || String(e.uid ?? e.friendId ?? f.friendId ?? ''),
            security_id: e.securityId || '',
        };
    });
}
const run=async (kwargs) => {

        const limit = readPositiveInteger(kwargs.limit, 'chatlist --limit', 20, 100);
        const pageNum = readPositiveInteger(kwargs.page, 'chatlist --page', 1);
        const side = kwargs.side || 'auto';

        if (side === 'boss') {

            const friends = await fetchFriendList({
                pageNum,
                jobId: kwargs['job-id'] || '0',
            });
            if (friends.length === 0)
                throw new EmptyResultError('boss chatlist', 'No recruiter-side chat sessions were returned.');
            return friends.slice(0, limit).map(mapBossRow);
        }

        if (side === 'geek') {
            if(!same('https://www.zhipin.com/web/geek/chat'))return navigate('https://www.zhipin.com/web/geek/chat');
            const rows = await buildGeekRows(limit);
            if (rows.length === 0)
                throw new EmptyResultError('boss chatlist', 'No job-seeker-side chat sessions were returned.');
            return rows;
        }

        // auto: try recruiter first, fall back to geek on identity mismatch

        const bossResult = await fetchFriendList({
            pageNum,
            jobId: kwargs['job-id'] || '0',
            allowNonZero: true,
        });
        if (Array.isArray(bossResult)) {
            if (bossResult.length === 0)
                throw new EmptyResultError('boss chatlist', 'No recruiter-side chat sessions were returned.');
            return bossResult.slice(0, limit).map(mapBossRow);
        }
        if (bossResult.code === IDENTITY_MISMATCH_CODE) {
            if(!same('https://www.zhipin.com/web/geek/chat'))return navigate('https://www.zhipin.com/web/geek/chat');
            const rows = await buildGeekRows(limit);
            if (rows.length === 0)
                throw new EmptyResultError('boss chatlist', 'No job-seeker-side chat sessions were returned.');
            return rows;
        }
        assertOk(bossResult);
        throw new CommandExecutionError('Boss chatlist returned an unexpected response');
    };
__webcliRegisterCommand("chatlist",async(args={})=>{args={...{"page":1,"limit":20,"job-id":"0","side":"auto"},...args};args["page"]=integer(args["page"],1,1000);args["limit"]=integer(args["limit"],20,1000);if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/'))return navigate('https://www.zhipin.com/web/chat/index');guard();return run(args);});})();
