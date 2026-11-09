/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;
const run=async (kwargs) => {

        const exchangeType = kwargs.type || 'phone';
        verbose(`Requesting ${exchangeType} exchange for ${kwargs.uid}...`);

        const friend = await findFriendByUid(kwargs.uid, { checkGreetList: true });
        if (!friend)
            throw new Error('未找到该候选人');
        const friendName = friend.name || '候选人';
        const typeId = exchangeType === 'wechat' ? 2 : 1;
        const params = new URLSearchParams({
            type: String(typeId),
            securityId: friend.securityId || '',
            uniqueId: String(friend.uid),
            name: friendName,
        });
        await bossFetch('https://www.zhipin.com/wapi/zpchat/exchange/request', {
            method: 'POST',
            body: params.toString(),
        });
        const typeLabel = exchangeType === 'wechat' ? '微信' : '手机号';
        return [{
                status: '✅ 交换请求已发送',
                detail: `已向 ${friendName} 发送${typeLabel}交换请求`,
            }];
    };
__webcliRegisterCommand("exchange",async(args={})=>{args={...{"type":"phone"},...args};if(typeof args["uid"]!=='string'||!args["uid"].trim())throw new ArgumentError("uid is required");if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/chat/'))return {__webcli_navigation:{version:1,url:'https://www.zhipin.com/web/chat/index',resume:false,phase:'prepare',result:{status:'prepared',message:'聊天页已准备，请核对目标后重新确认调用；尚未执行业务写操作。'}}};guard();return run(args);});})();
