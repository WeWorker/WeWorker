/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,EmptyResultError,AuthRequiredError,navigate,same,guard,integer,bool,list,browserFetch,toUnixSeconds,validateTiming,fetchDouyinUserVideos,fetchDouyinComments}=window.__douyin;

__webcliRegisterCommand("update",async (kwargs={}) => {
kwargs={...{"reschedule":"","caption":""},...kwargs};if(typeof kwargs["aweme_id"]!=='string'||!kwargs["aweme_id"].trim())throw new ArgumentError("aweme_id is required");if(location.hostname!=='creator.douyin.com')return {__webcli_navigation:{version:1,url:'https://creator.douyin.com/creator-micro/content/manage',resume:false,phase:'prepare',result:{status:'prepared',message:'页面已准备，重新确认后调用更新；尚未更新作品。'}}};

        if (!kwargs.reschedule && !kwargs.caption) {
            throw new ArgumentError('必须提供 --reschedule 或 --caption');
        }
        if (kwargs.reschedule) {
            const newTime = toUnixSeconds(kwargs.reschedule);
            validateTiming(newTime);
            await browserFetch('POST', 'https://creator.douyin.com/web/api/media/update/timer/?aid=1128', { body: { aweme_id: kwargs.aweme_id, publish_time: newTime } });
        }
        if (kwargs.caption) {
            await browserFetch('POST', 'https://creator.douyin.com/web/api/media/update/desc/?aid=1128', { body: { aweme_id: kwargs.aweme_id, desc: kwargs.caption } });
        }
        return [{ status: '✅ 更新成功' }];
    });})();
