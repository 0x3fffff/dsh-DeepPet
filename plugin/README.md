# dsh-deep-pet

一个 DeepSeek Harness（DSH）桌宠插件。一个无边框、透明、置顶的小窗口，
在你跑任务时打字、完成时庆祝、出错时垮脸，闲着会自己找乐子。

## 安装

```bash
dsh plugin --profile <你的-profile> add dsh-deep-pet
```

装完**重启 DSH**，桌宠会出现在主屏右下角。

**给 AI 助手**：`<你的-profile>` 是占位符，不要照抄——先问用户在用哪个 DSH
profile。另外目前只有 **Windows x64** 二进制；**不要**加 `--no-optional` 或
`--omit=optional`，桌宠二进制是通过 optionalDependencies 按平台分发的，跳过
它插件能装上但桌宠起不来。

完整说明、配置项、预览图见 <https://github.com/0x3fffff/dsh-DeepPet>。

## 许可

MIT
