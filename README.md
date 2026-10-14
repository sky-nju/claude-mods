# claude-mods

Sky 做的 Claude Code mods。mod 是装进 Claude Code 的一小段代码，可以改变 Claude Code 自己的界面和行为。

| mod | 做什么 |
|---|---|
| [红笔批阅 red-pen](red-pen/) | 像改稿子一样批 Claude 的回答：逐段「采纳 / 不要 / 啥意思 / 批注」，一键发出；长回答自动按规矩挑一遍毛病 |

![红笔批阅在桌面 App 里的样子](red-pen/docs/screenshot.png)

## 安装

在终端里运行（需要 Claude Code 2.1.287 或以上；先用 `claude --version` 确认，没有这个命令的看 [红笔批阅的安装说明](red-pen/README.md#安装)）：

```bash
claude plugin install red-pen --marketplace sky-nju/claude-mods
```

装好后，终端和桌面 App 新开的会话都会加载。
