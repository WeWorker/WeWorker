/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;
const run=async (kwargs) => {


        const friend = await findFriendByUid(kwargs.uid, { maxPages: 5 });
        if (!friend)
            throw new EmptyResultError('boss candidate search', '请确认 uid 是否正确');
        const numericUid = friend.uid;
        const friendName = friend.name || '候选人';
        const clicked = await clickCandidateInList(numericUid);
        if (!clicked) {
            throw selectorError('聊天列表中的用户', '请确认聊天列表中有此人');
        }
        await new Promise(r=>setTimeout(r,2000));
        const sent = await typeAndSendMessage(kwargs.text, numericUid);
        if (!sent) {
            throw selectorError('消息输入框', '聊天页面 UI 可能已改变');
        }
        await new Promise(r=>setTimeout(r,1000));
        return [{ status: '已点击发送，送达未验证', detail: `已为 ${friendName} 点击发送（送达未验证）: ${kwargs.text}` }];
    };
__webcliRegisterCommand("send",async(args={})=>{args={...{},...args};if(typeof args["uid"]!=='string'||!args["uid"].trim())throw new ArgumentError("uid is required");if(typeof args["text"]!=='string'||!args["text"].trim())throw new ArgumentError("text is required");if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/chat/'))return {__webcli_navigation:{version:1,url:'https://www.zhipin.com/web/chat/index',resume:false,phase:'prepare',result:{status:'prepared',message:'聊天页已准备，请核对目标后重新确认调用；尚未执行业务写操作。'}}};guard();return run(args);});})();
