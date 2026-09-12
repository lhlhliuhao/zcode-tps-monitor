#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"到状态文件(切会话后第一条消息即跟随)
// 2) 从 ZCode usage 数据库读取真实 token 输出速率,注入为上下文。输出必须为严格 JSON。
// 本轮即时速率由 Stop 钩子(hooks/stop.mjs)在回复刚结束时经 systemMessage 显示;
// 此处注入的是上一轮数据(发送瞬间本轮尚未发生)。
// 可选配置 ~/.zcode/tps-monitor.config.json:
//   {"tokenRateLine": false} 关闭速率注入;
//   {"stopHookLine": false}  停用本轮即时行,恢复由模型在回复末尾转发的旧行为。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, formatLine } from "../scripts/token-rate.mjs";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
if (sid) {
  try {
    const file = path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId: sid, ts: Date.now(), source: "prompt-submit" })
    );
  } catch {}
}

const QUOTE_HINT =
  "\n(用户要求:每条回复的末尾都用 Markdown 引用块原样附上上面整行内容——即在新行行首加「> 」再跟内容,使其渲染为浅色引用样式,不要省略、不要改写数字,引用块里只放这一行,不要追加任何链接或后缀)";

function readConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode", "tps-monitor.config.json"), "utf8")
    );
  } catch {
    return {};
  }
}

function emit(ctx) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } })
  );
}

try {
  const cfg = readConfig();
  if (cfg.tokenRateLine === false) {
    emit("");
  } else if (cfg.stopHookLine === false) {
    // 旧行为:Stop 钩子停用时,仍由模型在回复末尾转发(发送瞬间采样,只能描述上一轮)
    emit(formatLine(query(sid || null)) + QUOTE_HINT);
  } else {
    // 默认:本轮即时速率由 Stop 钩子在回复刚结束时直接显示给用户,
    // 这里注入的上一轮数据仅作为模型上下文,不再要求回复末尾转发
    emit(formatLine(query(sid || null)));
  }
} catch {
  emit("");
}
