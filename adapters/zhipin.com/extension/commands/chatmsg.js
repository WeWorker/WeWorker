/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,AuthRequiredError,EmptyResultError,integer,navigate,same,guard,bossFetch,verbose,selectorError,readPositiveInteger,readRequiredString,checkAuth,checkEnvironment,checkRecruiterSide,assertOk,fetchFriendList,fetchRecommendList,findFriendByUid,clickCandidateInList,typeAndSendMessage,readEncryptSystemId,fetchGeekFriendLabelList,fetchGeekFriendInfoList,findGeekFriendByUid,fetchGeekHistoryMsg,IDENTITY_MISMATCH_CODE}=window.__boss;const TYPE_MAP = {
    1: '文本', 2: '图片', 3: '招呼', 4: '简历', 5: '系统',
    6: '名片', 7: '语音', 8: '视频', 9: '表情',
};
function mapBossMsg(m, friend, index) {
    const fromObj = m.from || {};
    const isSelf = typeof fromObj === 'object' ? fromObj.uid !== friend.uid : false;
    return {
        message_ref: index + 1,
        from: isSelf ? '我' : (typeof fromObj === 'object' ? fromObj.name : friend.name),
        type: TYPE_MAP[m.type] || `其他(${m.type})`,
        text: m.text || m.body?.text || '',
        time: m.time ? new Date(m.time).toLocaleString('zh-CN') : '',
    };
}
function mapGeekMsg(m, friend) {
    const fromUid = m.from && m.from.uid;
    const isFromBoss = fromUid != null && String(fromUid) === String(friend.uid);
    return {
        from: isFromBoss ? '对方' : '我',
        type: TYPE_MAP[m.type] || `其他(${m.type})`,
        text: m.text || m.body?.text || m.body?.content || m.body?.showText ||
            JSON.stringify(m.body || {}).slice(0, 120),
        time: m.time ? new Date(m.time).toLocaleString('zh-CN') : '',
    };
}
async function bossChatMsg(kwargs, existingFriend) {
    const friend = existingFriend ?? await findFriendByUid(kwargs.uid);
    if (!friend) throw new EmptyResultError('boss chatmsg', '未找到该候选人');
    if (!friend.securityId) throw new CommandExecutionError('该聊天缺少 securityId，无法获取历史消息');
    const gid = friend.uid;
    const securityId = encodeURIComponent(friend.securityId);
    const msgUrl = `https://www.zhipin.com/wapi/zpchat/boss/historyMsg?gid=${gid}&securityId=${securityId}&page=${kwargs.page}&c=20&src=0`;
    const msgData = await bossFetch(msgUrl);
    const messages = msgData.zpData?.messages ?? msgData.zpData?.historyMsgList;
    if (!Array.isArray(messages)) {
        throw new CommandExecutionError('Boss recruiter history response did not include a message list');
    }
    if (messages.length === 0) {
        throw new EmptyResultError('boss chatmsg', 'Boss returned no messages for this chat.');
    }
    return messages.map((m, index) => mapBossMsg(m, friend, index));
}
async function geekChatMsg(kwargs, encryptSystemId) {
    const friend = await findGeekFriendByUid(kwargs.uid, { encryptSystemId });
    if (!friend) throw new EmptyResultError('boss chatmsg', '未找到该聊天（geek 侧）');
    if (!friend.securityId) throw new CommandExecutionError('该聊天缺少 securityId，无法获取历史消息');
    const messages = await fetchGeekHistoryMsg(friend, { page: kwargs.page });
    return messages.map((m) => mapGeekMsg(m, friend));
}
const run=async (kwargs) => {

        const uid = readRequiredString(kwargs.uid, 'chatmsg uid');
        const pageNum = readPositiveInteger(kwargs.page, 'chatmsg --page', 1);
        const normalizedKwargs = { ...kwargs, uid, page: pageNum };
        const side = kwargs.side || 'auto';

        if (side === 'boss') {

            return await bossChatMsg(normalizedKwargs);
        }

        if (side === 'geek') {
            if(!same('https://www.zhipin.com/web/geek/chat'))return navigate('https://www.zhipin.com/web/geek/chat');
            const encryptSystemId = await readEncryptSystemId();
            return await geekChatMsg(normalizedKwargs, encryptSystemId);
        }

        // auto: try recruiter first, fall back to geek when not found or identity mismatch

        const bossResult = await findFriendByUid(uid, { allowNonZero: true });
        if (bossResult?.friend) {
            return await bossChatMsg(normalizedKwargs, bossResult.friend);
        }
        // Not found or identity mismatch — check for hard errors before falling back
        if (bossResult?.code && bossResult.code !== 0 && bossResult.code !== IDENTITY_MISMATCH_CODE) {
            assertOk(bossResult);
        }
        // Fall back to geek side
        if(!same('https://www.zhipin.com/web/geek/chat'))return navigate('https://www.zhipin.com/web/geek/chat');
        const encryptSystemId = await readEncryptSystemId();
        const geekFriend = await findGeekFriendByUid(uid, { encryptSystemId });
        if (!geekFriend) throw new EmptyResultError('boss chatmsg', 'uid 在招聘端与求职端聊天列表中均未找到');
        if (!geekFriend.securityId) throw new CommandExecutionError('该聊天缺少 securityId，无法获取历史消息');
        const messages = await fetchGeekHistoryMsg(geekFriend, { page: pageNum });
        return messages.map((m) => mapGeekMsg(m, geekFriend));
    };
__webcliRegisterCommand("chatmsg",async(args={})=>{args={...{"page":1,"side":"auto"},...args};if(typeof args["uid"]!=='string'||!args["uid"].trim())throw new ArgumentError("uid is required");args["page"]=integer(args["page"],1,1000);if(location.hostname!=='www.zhipin.com'||!location.pathname.startsWith('/web/'))return navigate('https://www.zhipin.com/web/chat/index');guard();return run(args);});})();
