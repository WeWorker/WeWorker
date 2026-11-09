/* v2 command mail.qq.com.download-attachment; delegates to the preserved executable implementation. */
(function () {
  __webcliRegisterCommand("download-attachment", async function (params) {
    if (params?.emailId !== undefined) {
      const opened = await window["__mail_qq_com_internal"].invoke("mail.qq.com.open_email", { emailId: params.emailId });
      if (opened?.status !== 'opened' || opened.error) return { error: 'Source email could not be opened; attachment download was not started.' };
    }
    return window["__mail_qq_com_internal"].invoke("mail.qq.com.download_attachment", params || {});
  });
})();
