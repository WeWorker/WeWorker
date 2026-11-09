/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,EmptyResultError,AuthRequiredError,navigate,same,guard,integer,bool,list,browserFetch,toUnixSeconds,validateTiming,fetchDouyinUserVideos,fetchDouyinComments}=window.__douyin;

__webcliRegisterCommand("profile",async (kwargs={}) => {
kwargs={...{},...kwargs};if(location.hostname!=='creator.douyin.com')return navigate('https://creator.douyin.com/creator-micro/content/manage');

        const url = 'https://creator.douyin.com/web/api/media/user/info/?aid=1128';
        const res = (await browserFetch('GET', url));
        const u = res.user_info ?? res.user;
        if (!u)
            throw new CommandExecutionError('用户信息获取失败，请确认已登录 creator.douyin.com');
        return [
            {
                uid: u.uid == null ? null : String(u.uid),
                nickname: u.nickname,
                follower_count: u.follower_count,
                following_count: u.following_count,
                aweme_count: u.aweme_count,
            },
        ];
    });})();
