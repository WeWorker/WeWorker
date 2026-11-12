/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;
const run=async (kwargs) => {

        verbose(`Sending interview invitation to ${kwargs.uid}...`);

        const friend = await findFriendByUid(kwargs.uid, { checkGreetList: true });
        if (!friend)
            throw new Error('未找到该候选人');
        const friendName = friend.name || '候选人';
        // Get saved contact info
        const contactData = await bossFetch('https://www.zhipin.com/wapi/zpinterview/boss/interview/contactInit', { allowNonZero: true, timeout: 10_000 });
        const contactName = kwargs.contact || contactData.zpData?.contactName || '';
        const contactPhone = contactData.zpData?.contactPhone || '';
        const contactId = contactData.zpData?.contactId || '';
        // Get saved address
        const addressData = await bossFetch('https://www.zhipin.com/wapi/zpinterview/boss/interview/listAddress', { allowNonZero: true, timeout: 10_000 });
        const savedAddress = addressData.zpData?.list?.[0] || {};
        const addressText = kwargs.address || savedAddress.cityAddressText || savedAddress.addressText || '';
        // Parse interview time
        const interviewTime = new Date(kwargs.time).getTime();
        if (isNaN(interviewTime)) {
            throw new Error(`时间格式错误: ${kwargs.time}，请使用格式如 2025-04-01 14:00`);
        }
        const params = new URLSearchParams({
            uid: String(friend.uid),
            securityId: friend.securityId || '',
            encryptJobId: friend.encryptJobId || '',
            interviewTime: String(interviewTime),
            contactId,
            contactName,
            contactPhone,
            address: addressText,
            interviewType: '1',
        });
        await bossFetch('https://www.zhipin.com/wapi/zpinterview/boss/interview/invite.json', {
            method: 'POST',
            body: params.toString(),
        });
        return [{
                status: '✅ 面试邀请已发送',
                detail: `已向 ${friendName} 发送面试邀请\n时间: ${kwargs.time}\n地点: ${addressText}\n联系人: ${contactName}`,
            }];
    };
__webcliRegisterCommand("invite",async(args={})=>{args={...{"address":"","contact":""},...args};if(typeof args["uid"]!=='string'||!args["uid"].trim())throw new ArgumentError("uid is required");if(typeof args["time"]!=='string'||!args["time"].trim())throw new ArgumentError("time is required");if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/chat/'))return {__webcli_navigation:{version:1,url:'https://www.zhipin.com/web/chat/index',resume:false,phase:'prepare',result:{status:'prepared',message:'聊天页已准备，请核对目标后重新确认调用；尚未执行业务写操作。'}}};guard();return run(args);});})();
