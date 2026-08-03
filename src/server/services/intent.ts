import type { AssistantIntent, ChatMessage } from "../../shared/types";

const imagePattern =
  /(生成|绘制|做一张|来一张|create|generate|draw|image|picture|photo|海报|插画|图片)/i;
const filePattern =
  /(生成|创建|导出|写成|保存为|下载|文件|文档|表格|csv|xlsx|json|txt|md|markdown|report|download|file)/i;

const explicitDataCodePattern =
  /(用代码|运行代码|执行代码|生成代码|写代码|本地代码|保存代码|保留代码|code|script|programmatically|run code|execute code)/i;
const preciseDataPattern =
  /(精确计算|精确值|精准计算|按数据计算|拉取数据|获取数据接口|调用接口|通过接口|接口数据|fetch data|api\s*(获取|拉取|计算|数据|行情|k线|klines)|binance\s*api)/i;

export const detectIntent = (messages: ChatMessage[]): AssistantIntent => {
  const latest = messages[messages.length - 1]?.content ?? "";

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
