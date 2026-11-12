/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;
const run=async (kwargs) => {

        const filterJobId = kwargs['job-id'] || '';
        const limit = kwargs.limit || 5;
        const text = kwargs.text || '你好，请问您对这个职位感兴趣吗？';
        verbose(`Batch greeting up to ${limit} candidates...`);

        let candidates = await fetchRecommendList();
        if (filterJobId) {
            candidates = candidates.filter((f) => f.encryptJobId === filterJobId);
        }
        candidates = candidates.slice(0, limit);
        if (candidates.length === 0) {
            return [{ name: '-', status: '⚠️ 无候选人', detail: '当前没有待招呼的推荐候选人' }];
        }
        const results = [];
        for (const candidate of candidates) {
            const numericUid = candidate.uid;
            const friendName = candidate.name || '候选人';
            try {
                const clicked = await clickCandidateInList(numericUid);
                if (!clicked) {
                    results.push({ name: friendName, status: '❌ 跳过', detail: '在聊天列表中未找到' });
                    continue;
                }
                await new Promise(r=>setTimeout(r,2000));
                const sent = await typeAndSendMessage(text, numericUid);
                if (!sent) {
                    results.push({ name: friendName, status: '❌ 失败', detail: '找不到消息输入框' });
                    continue;
                }
                await new Promise(r=>setTimeout(r,1500));
                results.push({ name: friendName, status: '已点击发送，送达未验证', detail: text });
            }
            catch (e) {
                results.push({ name: friendName, status: '❌ 失败', detail: e.message?.substring(0, 80) || '未知错误' });
            }
        }
        return results;
    };
__webcliRegisterCommand("batchgreet",async(args={})=>{args={...{"job-id":"","limit":5,"text":""},...args};args["limit"]=integer(args["limit"],5,1000);if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/chat/'))return {__webcli_navigation:{version:1,url:'https://www.zhipin.com/web/chat/index',resume:false,phase:'prepare',result:{status:'prepared',message:'聊天页已准备，请核对目标后重新确认调用；尚未执行业务写操作。'}}};guard();return run(args);});})();
