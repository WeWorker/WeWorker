/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;
const run=async (kwargs) => {

        verbose(`Greeting candidate ${kwargs.uid}...`);

        // Find candidate in greet list or friend list
        const friend = await findFriendByUid(kwargs.uid, {
            maxPages: 1,
            checkGreetList: true,
        });
        if (!friend) {
            throw new Error('未找到该候选人，请确认 uid 是否正确（可从 recommend 命令获取）');
        }
        const numericUid = friend.uid;
        const friendName = friend.name || '候选人';
        const clicked = await clickCandidateInList(numericUid);
        if (!clicked) {
            throw new Error('无法在聊天列表中找到该用户，候选人可能不在当前列表中');
        }
        await new Promise(r=>setTimeout(r,2000));
        const msgText = kwargs.text || '你好，请问您对这个职位感兴趣吗？';
        const sent = await typeAndSendMessage(msgText, numericUid);
        if (!sent) {
            throw new Error('找不到消息输入框');
        }
        await new Promise(r=>setTimeout(r,1000));
        return [{ status: '已点击发送，送达未验证', detail: `已向 ${friendName} 点击发送: ${msgText}` }];
    };
__webcliRegisterCommand("greet",async(args={})=>{args={...{"text":""},...args};if(typeof args["uid"]!=='string'||!args["uid"].trim())throw new ArgumentError("uid is required");if(typeof args["security-id"]!=='string'||!args["security-id"].trim())throw new ArgumentError("security-id is required");if(typeof args["job-id"]!=='string'||!args["job-id"].trim())throw new ArgumentError("job-id is required");if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/chat/'))return {__webcli_navigation:{version:1,url:'https://www.zhipin.com/web/chat/index',resume:false,phase:'prepare',result:{status:'prepared',message:'聊天页已准备，请核对目标后重新确认调用；尚未执行业务写操作。'}}};guard();return run(args);});})();
