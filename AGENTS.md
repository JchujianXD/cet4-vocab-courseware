@~/.Codex/workflows/dev-collab.md

# 刘晓艳网页课件生成

以《英语四级 · 你还在背单词吗》Part 01（Unit 1–10）的课为基础，转成可交互的网页课件，并用 AI 补全教材缺少的内容：思维导图、发音、例句朗读高亮、点词查义、背诵遮挡、磨耳朵；首页是背词门户（学习记录、巩固模式、滚动复习、周总结）。

## 常用命令

- 安装依赖：`pip install pypdf pillow edge-tts`
- 启动：`python -m http.server 8765 --directory site`，打开 http://localhost:8765 （不能直接双击 HTML，fetch 会被拦）
- 全量测试：`python pipeline/validate.py`（校验所有课的数据）+ `node --test "tests/*.test.js"`（复习规则单元测试）
- 批量生成课程：用项目技能 `make-lesson`（`.Codex/skills/make-lesson/SKILL.md`），子代理在 `.Codex/agents/`（抽取 Sonnet、释义 Haiku）；音频走云端 `audio` 工作流，启动子代理前按技能第 4 节查额度（至少留 5%）
- 查进度：`python pipeline/lessons.py --todo 1 10`（Part 02 即 Unit 11–12 不做，已从 `toc.json` 删除）
- 部署：先 `python pipeline/publish_audio.py` 推音频，再推主仓库 `main`，自动部署（`.github/workflows/deploy.yml`：校验 → 检查音频已上线 → 目录索引 → GitHub Pages）。线上地址 https://cet4.owenwoow.com/（自定义域名，旧的 github.io 地址会自动跳转过来；云同步 token 按网址存，要在这个地址下粘贴）
- 每次站点更新上线时，在 GitHub Releases 发布一个版本，并用简体中文说明本次更新的内容。
- 云端生成音频（默认，本地网络跑 edge-tts 会卡死）：Actions → `audio` 工作流（`.github/workflows/audio.yml`），手动触发，填课程 id；并发固定 3（服务器 IP 易被限流），生成后自动推音频仓库并把清单提交回 `main`。需要 Secret `AUDIO_REPO_TOKEN`（PAT，详见工作流文件头部）
- 本地预览要起两个服务：课件 8765（`site/`）、音频 8766（`audio-store/`），见 `.Codex/launch.json`；8765 被占用时用备用的 `site-alt`（8775，localStorage 按端口隔离，测试数据不串）
- 本地快速验收：运行 `python devtools/local-test-server.py`，打开 http://127.0.0.1:18775/test；音频另起 8766。按入口进入各模式，每次重置演示进度。工具只监听本机，独立端口存储演示数据并阻断云同步；不得连接真实 Gist 或导入真实学习数据。两台开发机通过 Git 同步 `devtools/` 代码，测试记录各自留在本机；该目录不部署到网站。每次需要用户验收时优先启动此入口并告知测试范围。
- 新电脑上恢复音频目录：`git clone https://github.com/Owenwoow/cet4-vocab-audio.git audio-store`
- 讲解视频时间点：`python pipeline/video_align.py` 重新对齐生成 `site/data/video/`（只在本机跑：要 B 站登录 cookie，环境变量 `BILI_COOKIE`，默认 `~/Downloads/bilibili_cookie.json`；字幕缓存在 `work/bili/`，没缓存时约 280 次请求、5 分钟）；`--check` 查视频是否下架并更新 `alive`（不用 cookie）；`--sample 3 --seed N` 每单元抽 3 词打印落点前后字幕。视频下架或有人重新上传：改 `pipeline/video_sources.json` 再重跑

## 核心模块

<!-- /dev-task 据此给分组定难度：碰到这些路径的组用更强的模型，合并后做代码审查；小改动碰到这里也按大改动走 -->

- `site/srs.js`：复习规则，改错了复习安排会悄悄乱掉；改了要同步 `tests/srs.test.js`
- `site/recall.js`：回忆提示、首次表现、有限补测和断点快照；改了同步 `tests/recall.test.js`。词卡沿用原布局，以模糊遮挡展开；日常新规则先读 `docs/plans/2026-10-28-active-recall.md`
- `site/sync.js`：存储与云同步，所有进度都经过它，改错可能丢学习记录，或者两台设备互相覆盖
- `site/sent.js` 开头的词组定位规则 + `pipeline/validate.py` 的 `check_notes`：两边必须一致，只改一边时页面上词组会错位，校验却照样通过
- `pipeline/validate.py`：所有课数据的把关，部署工作流第一步就跑它；校验放松了，坏数据会直接上线

## 目录

- `pipeline/`：流水线脚本和提示词（`prompts/`），`toc.json` 是手录的书目录
- `site/`：静态站点，直接托管这个目录；`site/data/lessons/*.json` 是唯一数据源。`app.js` 课文与设置，`study.js` 首页 / 记录 / 巩固 / 浏览 / 周总结，`srs.js` 复习规则（纯函数），`vocab.js` 生词本的取原形 / 拆释义（纯函数），`sync.js` 存储与云同步，`backup.js` 导出 / 导入备份的分类与合并 / 覆盖规则（纯函数）
- `site/data/roots/*.json`：词根词缀记忆法补充（书外、AI 生成），只给书上用联想/谐音法且能拆出公认词根的词条补，页面标「补充」；`validate.py` 会核对
- `site/data/notes/*.json`：例句词组标注与语法解析（书外、AI 生成，子代理 `note-writer` 按 `pipeline/prompts/notes.md` 写），按例句英文原文索引；词组片段的定位规则在 `site/sent.js` 开头，和 `validate.py` 的 `check_notes` 必须一致；页面标「补充」
- `site/data/audio/*.json`：每课音频清单（进 git）；音频文件本身在单独的仓库 `cet4-vocab-audio`，本地克隆在 `audio-store/`（主仓库忽略）
- `site/data/video/*.json`：每课每个词条在各 B 站讲解视频里的「分 P、秒」（`pipeline/video_align.py` 从 AI 字幕对齐生成），前端选视频规则在 `site/video.js`；视频表（优先级、分 P 范围和时长）手录在 `pipeline/video_sources.json`
- `site/data/pages/`、`work/`：脚本生成，不进 git
- `devtools/`：随仓库同步的本地验收工具，不放入 `site/`，不部署

## 项目约束

- 内容与书上逐字一致；书外补充（`site/data/gloss/`）在页面上标「补充」
- 仓库和网站是公开的，允许搜索引擎收录（2026-10-20 起，见 `docs/plans/2026-10-20-seo.md`）：SEO 只做首页级（`index.html` 头部的 description / OG / 结构化数据 / `<noscript>` 简介，`site/robots.txt` 放开并指向 `site/sitemap.xml`），**不为每课生成静态页**，免得原书内容被成段收录；网页顶栏和页脚有回 GitHub 项目的链接，README 截图在 `docs/images/`
- 原书扫描页（`site/data/pages/`）不进仓库、不部署，「看原书」只在本地版出现（`book.json` 的 `hasPages`）
- 书页码 = PDF 页序号(0 起) − 9（`pipeline/config.py`）
- 每个 Lesson 的词条序号从 01 重新开始；词群编号在整个 Unit 内连续
- B 站 cookie 只在本机读，不打印、不进仓库、不进 Actions；字幕原文只缓存在 `work/bili/`，仓库里只放时间点
- 学习进度（已会、设置、上次的课、每课阅读位置）统一走 `site/sync.js` 存取，不要直接写 localStorage；新增要跨设备同步的状态也走它。云端是用户自己的私密 Gist（`cet4-progress.json`），token 只存本机，绝不写进仓库
- 背词数据也走 `sync.js`：`learn:<课id>:g<词群号>` = 学的日期，`srs:<词>` = 复习卡，`log:<日期>` = 当天评分计数，`drill:<范围>` = 巩固做到一半的进度（当天有效、做完记 0），`vocab:<原形>` = 生词本（释义快照 + 复习卡，和 `srs:` 分开存，所在词群记为学过时记 0「毕业」）；取消记 0（墓碑），不要删键
- 回忆升级保留旧卡等级和到期日期，旧选择成绩不追认为独立回忆；`recall`、`skills`、`life`、`attempts` 嵌入原卡，毕业转卡时保留。`evening:<日期>` 独立记录晚间任务，`browse:<日期>` 只记浏览；专项不推进词义排期。备份只恢复同一学习日的有效断点，详见本次计划；不要用迁移时间覆盖旧卡的同步时间。
- 复习规则只在 `site/srs.js` 改，改了同步改 `tests/srs.test.js`；规则说明写在文件开头和 `docs/plans/2026-10-01-vocab-portal.md`
- 组件库 Web Awesome 只引主题变量 `themes/default.css` 和组件加载器，不引 `native.css`、不用 `wa-page`（会改动课文页）；版本号写死在 `index.html`。新增脚本要加进部署工作流的版本号 sed
- 同组同排的操作按钮必须等宽、等高、同字号，原生按钮和 Web Awesome 按钮也不例外；使用正常按钮宽度，整组居中，不拉伸到与词卡齐边。练习操作栏与结束页共用 `style.css` 的按钮尺寸规则（高度 44px、字号 16px）；不能只检查组件外框，要实测 `::part(base)` 的可见边框，检查窄屏和放大后的换行及文字完整性。
- 修改样式后同步更新 `index.html` 中本地 `style.css?v=…` 的版本；部署工作流须兼容并替换已有版本号。复验不能只在无缓存的新浏览器里测，还应覆盖缓存旧 CSS 后更新页面的情况。

## 交付习惯

- 每次做完改动、等我确认推送上线时：先用 `.Codex/launch.json` 起一个本地预览端口（默认 `site` 8765，被占用就用 `site-alt` 8775；要听音频再起 `audio` 8766），在回复里给出地址和要看哪几处，让我先在本地看修改结果，确认后再推送。8775 的学习数据和 8765、线上互不相通，要看依赖学习记录的页面时说明一句或先造好演示数据

## 本项目例外

- 发现工作区里有不是你改的未提交改动（多半是我手改的）：先看内容，合理（不含凭据、和当前任务不冲突、改完测试照样全绿）就和这次的改动一起提交到 `main`，提交信息里写明「含用户手改：…」，汇报时说一句；看不懂或觉得有问题的先问我。有别的 worktree 在干活（别的会话正在改）时不适用，照协作规范先提醒
