import type { AssistantIntent, ChatMessage } from "../../shared/types";

const hasUploadedImage = (message: ChatMessage): boolean =>
  Boolean(
    message.attachments?.some(
      (attachment) =>
        attachment.source === "uploaded" &&
        (attachment.kind === "image" || attachment.mimeType.startsWith("image/"))
    )
  );

const imageAnalysisPattern =
  /(分析|解读|识别|总结|提取|读取|读一下|看一下|说明|描述|内容|文字|截图|ocr|OCR|analyze|describe|read|extract|summarize|transcribe)/i;

const imagePattern =
  /(生成|绘制|画一张|做一张|来一张|出图|海报|插画|改图|修图|修改|编辑|改为|改成|变成|换成|去掉|加上|添加|重新生成|再生成|create|generate|draw|poster|illustration|edit|modify|make.*image)/i;

const imageEditWithUploadPattern =
  /(改|修|编辑|改为|改成|变成|换成|去掉|加|添加|放入|替换|保留|生成|重新|再生成|飞机|直升机|楼|建筑|撞|撞击|坠毁|爆炸|烟|火|edit|modify|change|turn|replace|add|remove|generate|regenerate|crash|collision|explode|smoke|fire)/i;

const filePattern =
  /(生成|创建|导出|写成|保存为|下载|文件|文档|表格|csv|xlsx|json|txt|md|markdown|report|download|file)/i;

const explicitDataCodePattern =
  /(用代码|运行代码|执行代码|生成代码|写代码|本地代码|保存代码|保留代码|code|script|programmatically|run code|execute code)/i;

const preciseDataPattern =
  /(精确计算|精确值|精准计算|按数据计算|拉取数据|获取数据接口|调用接口|通过接口|接口数据|fetch data|api\s*(获取|拉取|计算|数据|行情|k线|klines)|binance\s*api)/i;

export const detectIntent = (messages: ChatMessage[]): AssistantIntent => {
  const latestMessage = messages[messages.length - 1];
  const latest = latestMessage?.content ?? "";

  if (
    latestMessage &&
    hasUploadedImage(latestMessage) &&
    imageAnalysisPattern.test(latest) &&
    !imagePattern.test(latest)
  ) {
    return "chat";
  }

  if (latestMessage && hasUploadedImage(latestMessage) && imageEditWithUploadPattern.test(latest)) {
    return "image";
  }

  if (imagePattern.test(latest)) {
    return "image";
  }

  if (explicitDataCodePattern.test(latest) || preciseDataPattern.test(latest)) {
    return "data";
  }

  if (filePattern.test(latest)) {
    return "file";
  }

  return "chat";
};
