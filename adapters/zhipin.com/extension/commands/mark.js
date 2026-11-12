/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;const LABEL_MAP = {
    '新招呼': 1, '沟通中': 2, '已约面': 3, '已获取简历': 4,
    '已交换电话': 5, '已交换微信': 6, '不合适': 7, '牛人发起': 8, '收藏': 11,
};
const run=async (kwargs) => {

        const labelInput = kwargs.label;
        const remove = kwargs.remove || false;
        // Resolve label to ID
        let labelId;
        if (LABEL_MAP[labelInput]) {
            labelId = LABEL_MAP[labelInput];
        }
        else if (!isNaN(Number(labelInput))) {
            labelId = Number(labelInput);
        }
        else {
            const entry = Object.entries(LABEL_MAP).find(([k]) => k.includes(labelInput));
            if (entry) {
                labelId = entry[1];
            }
            else {
                throw new ArgumentError(`未知标签: ${labelInput}。可用标签: ${Object.keys(LABEL_MAP).join(', ')}`);
            }
        }
        verbose(`${remove ? 'Removing' : 'Adding'} label ${labelId} for ${kwargs.uid}...`);

        const friend = await findFriendByUid(kwargs.uid, { checkGreetList: true });
        if (!friend)
            throw new EmptyResultError('boss candidate search');
        const friendName = friend.name || '候选人';
        const action = remove ? 'deleteMark' : 'addMark';
        const params = new URLSearchParams({
            friendId: String(friend.uid),
            friendSource: String(friend.friendSource ?? 0),
            labelId: String(labelId),
        });
        await bossFetch(`https://www.zhipin.com/wapi/zprelation/friend/label/${action}?${params.toString()}`);
        const labelName = Object.entries(LABEL_MAP).find(([, v]) => v === labelId)?.[0] || String(labelId);
        return [{
                status: remove ? '✅ 标签已移除' : '✅ 标签已添加',
                detail: `${friendName}: ${remove ? '移除' : '添加'}标签「${labelName}」`,
            }];
    };
__webcliRegisterCommand("mark",async(args={})=>{args={...{"remove":false},...args};if(typeof args["uid"]!=='string'||!args["uid"].trim())throw new ArgumentError("uid is required");if(typeof args["label"]!=='string'||!args["label"].trim())throw new ArgumentError("label is required");if(args["remove"]==='true')args["remove"]=true;else if(args["remove"]==='false')args["remove"]=false;else if(typeof args["remove"]!=='boolean')throw new ArgumentError('Expected boolean');if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/chat/'))return {__webcli_navigation:{version:1,url:'https://www.zhipin.com/web/chat/index',resume:false,phase:'prepare',result:{status:'prepared',message:'聊天页已准备，请核对目标后重新确认调用；尚未执行业务写操作。'}}};guard();return run(args);});})();
