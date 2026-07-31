import type { AssistantIntent, ChatMessage } from "../../shared/types";

const imagePattern =
  /(生成|画|绘制|做一张|来一张|create|generate|draw|image|picture|photo|海报|插画|图片)/i;
const filePattern =
  /(生成|创建|导出|写成|保存为|下载|文件|文档|表格|csv|xlsx|json|txt|md|markdown|report|download|file)/i;
const dataPattern =
  /(统计|分析数据|整理数据|计算|汇总|排序|去重|平均|方差|标准差|csv|表格|dataset|data|statistics|analy[sz]e)/i;

export const detectIntent = (messages: ChatMessage[]): AssistantIntent => {
  const latest = messages[messages.length - 1]?.content ?? "";

  if (imagePattern.test(latest)) {
    return "image";
  }

  if (dataPattern.test(latest)) {
    return "data";
  }

  if (filePattern.test(latest)) {
    return "file";
  }

  return "chat";
};
