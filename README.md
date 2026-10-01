# pi-ide-selection

复用已安装的 Claude Code IDE 插件，把编辑器选区作为独立上下文消息提供给 Pi。选区取自编辑器内存，包含未保存的修改，不需要安装额外的 IDE 插件。

在 IDE 中选中代码，再到 Pi 提问。选区随下一条问题发送，用户输入保持原样；发送后清空待发送选区，后续问题不会自动重复附加。

## 安装

需要 Pi 0.86.1+、Node.js 22.6+，以及已安装并启用的 Claude Code IDE 插件。Pi 当前工作目录应位于 IDE 打开的项目内。

```bash
pi install git:github.com/yungyu16/pi-ide-selection
```

安装后执行 `/reload` 或重启 Pi。更新时执行：

```bash
pi update git:github.com/yungyu16/pi-ide-selection
```

本项目以 Git 包分发，GitHub 仓库公开；`package.json` 的 `private: true` 仅用于防止意外发布 npm。不依赖 my-pi、个人配置或自定义 footer，Pi 默认 footer 即可显示选区状态。

## 使用

1. 在 IDE 中选中要提供的代码。
2. 确认 Pi footer 出现 `⧉ 路径:行范围 · N 行`。
3. 输入问题；选区会以“IDE 选区”消息显示在问题前。

| 入口 | 用途 |
| --- | --- |
| `/ide status` | 查看连接、插件版本、待发送选区和提示词挂载状态 |
| `/ide on` / `/ide off` | 会话内启用或关闭 |
| `/ide clear` | 丢弃待发送选区 |
| `/ide reconnect` | IDE 重启或端口变化后重连 |
| `--no-ide-selection` / `PI_IDE_SELECTION=0` | 启动时关闭 |

未发现匹配当前项目的 IDE 时不占 footer。选区超过 400 行或 32KB 时截断；发送给模型的正文保留 XML 和绝对路径，界面使用相对路径和代码视图。

选区只是上下文，可能无关或误选。扩展通过系统提示词说明其来源与使用边界；涉及磁盘状态的判断仍应读取文件核对。

## 兼容性与限制

- 已联调环境：macOS、IntelliJ IDEA 2026.2、Claude Code JetBrains 插件 0.1.14-beta、Pi 0.87.0、Node.js 24。兼容声明从 Pi 0.86.1 起；自动测试使用锁定的 Pi 0.86.1。
- VS Code 系载荷已做解析兼容，但尚未真实联调；Windows/WSL 也尚未验证。
- 连接依赖 Claude Code 插件未公开的本地 WebSocket 协议，插件升级可能影响兼容性。本项目是独立社区扩展，与 Anthropic 无隶属关系。
- 选区和问题是两条消息，宿主队列无法保证原子绑定；后续输入被拦截或请求失败时，选区可能已进入会话。已发送选区保留在会话历史中。
- 扩展会读取 `~/.claude/ide/*.lock` 中的本机认证信息；选中文本随问题发送给当前模型，请先确认选区内容适合发送。

更多协议、展示、排障与消息交付边界见 [实现与兼容性](docs/实现与兼容性.md)。

## 开发与验证

使用 `.nvmrc` 声明的 Node.js 版本：

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

测试覆盖协议解析、选区生命周期、渲染、WebSocket 关闭、Pi 实际消息队列及独立 loader 发现，使用本地模型桩，不请求外部模型。真实 IDE 联调和 Pi `/reload` 后的视觉效果需人工验证。

Pi 核心依赖由宿主提供；`ws` 是运行时依赖，因为插件认证需要自定义 WebSocket 请求头。源码统一放在 `src/`，`pi.extensions: ["./src/index.ts"]` 显式声明入口，不依赖目录发现约定。无需编译，Pi 直接加载 TypeScript。

锁定的开发用 Pi SDK 间接依赖 `brace-expansion` 当前有 `npm audit` 高危告警，常规依赖更新未能消除；本包不通过覆盖宿主依赖来修复，运行时 SDK 由安装者的 Pi 提供。

## 许可证

[MIT](LICENSE)。
