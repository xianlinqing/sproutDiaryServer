export function wechatExchange(appId: string, secret: string) {
  return async (code: string): Promise<string> => {
    if (!secret) throw Error("微信登录尚未配置");
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.search = new URLSearchParams({
      appid: appId,
      secret,
      js_code: code,
      grant_type: "authorization_code",
    }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error("微信服务暂不可用");
    const data = (await response.json()) as {
      openid?: string;
      errcode?: number;
    };
    if (data.errcode || !data.openid) throw Error("微信凭证无效，请重新登录");
    return data.openid;
  };
}
