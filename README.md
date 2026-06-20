# PTA DeepSeek 自动答题助手

在 PTA（pintia.cn）考试页面自动答题的 Tampermonkey/ScriptCat 用户脚本。提取题目内容，调用 DeepSeek API 推理答案，自动勾选/填充。

## 支持的题型

| 题型 | 自动勾选 | 说明 |
|------|---------|------|
| 单选题 | ✅ | 自动找到对应 radio 并点击 |
| 多选题 | ✅ | 逐个勾选所有正确选项 |
| 判断题 | ✅ | 自动匹配 T/F → 正确/错误 |
| 填空题 | ✅ | 自动填充 input/textarea |

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [ScriptCat](https://scriptcat.org/) 浏览器扩展
2. 打开 `PTA-auto-answer.user.js` 文件，复制全部内容
3. 在扩展中新建脚本，粘贴并保存
4. 或者直接拖拽 `.user.js` 文件到浏览器

## 配置

1. 获取 [DeepSeek API Key](https://platform.deepseek.com/)
2. 打开 PTA 考试页面（`https://pintia.cn/problem-sets/*/exam/*`）
3. 右下角会出现紫色面板
4. 输入 API Key，点「保存」
5. 先点「单题」测试，确认无误后点「全部答题」

## 两种模式

- **自动勾选**（默认）：获取答案后自动点击选项/填充答案
- **仅显示答案**：关闭「自动勾选」开关，答案只显示在面板中

## 许可证

MIT License
