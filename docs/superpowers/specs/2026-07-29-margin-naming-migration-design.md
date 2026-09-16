# Margin 命名迁移设计规格

## 1. 背景

项目当前正式名称为 Margin。Echo 是产品定位收敛前使用的旧名称，但仓库中仍保留大量 Echo 命名，分布在环境变量、默认数据库路径、Docker 配置、启动脚本、运行日志、服务文件、持久化字段、测试和历史设计文档中。

当前用户可见前端和新版 Case Study 已基本使用 Margin。命名迁移的目标不是抹去产品演进历史，而是让当前产品、当前开发入口和后续新增代码以 Margin 为唯一默认名称，同时确保旧环境和旧数据继续可用。

## 2. 目标

本次迁移需要实现：

1. 当前用户可见产品名称统一为 Margin。
2. 新配置、默认数据库和新生成文件统一使用 Margin 命名。
3. 旧 `ECHO_*` 环境变量、旧数据库路径和旧备份继续兼容。
4. 数据库字段、事件来源和备份结构不发生破坏性变化。
5. Case Study 和历史材料中的 Echo → Margin 演进叙事得到保留。
6. 后续开发不再新增缺乏兼容必要性的 Echo 命名。

## 3. 非目标

本轮不包含：

- 自动修改 GitHub 仓库名称；
- 自动改变本地仓库目录；
- 重写 Git 历史、发布记录或旧设计决策；
- 将数据库字段 `echo_response`、`echo_reflection` 直接改名；
- 将持久化事件值 `echo_state` 直接改名；
- 为纯内部 CSS 类名、DOM ID 做无收益的批量替换；
- 重新设计 Margin 的产品定位、界面或功能。

## 4. 审计结论

### 4.1 已经使用 Margin 的区域

- `README.md` 的当前产品标题和定位；
- `public/index.html` 与 `public/app.js` 的主要可见品牌；
- 双语 Case Study、PDF 和招聘方速览；
- 近期规格、实施计划和部署材料。

### 4.2 需要迁移的当前产品入口

- `package.json` 与 `package-lock.json` 的包名、描述和关键词；
- `.env.example`、`Dockerfile`、`docker-compose.yml`；
- `src/config/env.js` 与 provider 配置读取；
- `src/app.js`、`src/server.js`、`electron/main.js` 的当前产品文案；
- 备份、导入和部署脚本的当前产品文案与新文件名；
- `run-echo-local.cmd`、`run-echo-desktop.cmd`；
- 当前 API、运行和维护文档的标题及现行描述；
- Case Study 中仍指向旧仓库地址的资源配置。

### 4.3 必须保留兼容的遗留标识

- `ECHO_LOG_LEVEL`、`ECHO_LLM_PROVIDER`、`ECHO_DB_PATH`；
- 默认旧数据库 `data/echo.sqlite`；
- `echo_response`、`echo_reflection` 等数据库与 API 字段；
- `echo_state` 等已持久化事件或来源值；
- 能被旧导出文件依赖的快照字段；
- 描述产品演进的 Echo 历史材料。

## 5. 推荐方案：分层渐进迁移

### 5.1 当前品牌层

所有面向用户、开发者和运行维护人员的当前产品名称统一为 Margin，包括：

- 页面标题和可见文案；
- API 健康信息和服务元信息；
- 日志前缀、错误提示和 Electron 状态信息；
- 包描述、Docker 服务名和部署脚本输出；
- 当前维护文档的标题和说明。

历史引用只有在明确说明“旧名称”或“Echo 阶段”时才允许继续出现。

### 5.2 配置兼容层

新增并优先读取：

- `MARGIN_LOG_LEVEL`
- `MARGIN_LLM_PROVIDER`
- `MARGIN_DB_PATH`

读取优先级固定为：

1. `MARGIN_*`
2. 对应的 `ECHO_*`
3. Margin 默认值

如果新旧变量同时存在，以 `MARGIN_*` 为准。

如果只使用旧变量，应用继续正常启动，并通过日志记录一次弃用警告。警告不得包含密钥或变量值。

如果 `MARGIN_LLM_PROVIDER` 的值无效，错误信息必须指向 `MARGIN_LLM_PROVIDER`。如果值来自旧变量，则错误信息同时说明它来自兼容变量 `ECHO_LLM_PROVIDER`。

### 5.3 数据库路径迁移

新安装默认数据库为：

```text
data/margin.sqlite
```

未显式配置数据库路径时，按以下规则选择：

1. 如果 `data/margin.sqlite` 已存在，使用它；
2. 否则如果 `data/echo.sqlite` 已存在，继续使用旧数据库，并记录一次兼容提示；
3. 两者均不存在时，创建 `data/margin.sqlite`。

系统不得自动移动、重命名、复制或删除用户数据库。显式设置的 `MARGIN_DB_PATH` 或 `ECHO_DB_PATH` 始终高于默认路径探测。

### 5.4 持久化与 API 兼容

以下名称在本阶段作为 legacy schema 保留：

- `echo_response`
- `echo_reflection`
- `echo_state`
- `echo_interaction_style`

保留原因是它们可能存在于数据库表、API 响应、备份快照、测试夹具或用户已有数据中。当前代码可以继续读写这些字段，但新增业务概念不得继续使用 Echo 作为前缀。

源码中涉及这些字段的位置应增加集中说明，明确：

- 它们是兼容字段，不代表当前品牌；
- 删除或改名需要独立的数据迁移版本；
- 任何未来替换必须提供双读、迁移和回滚方案。

### 5.5 文件、脚本和生成物

新增 Margin 命名入口：

- `run-margin-local.cmd`
- `run-margin-desktop.cmd`
- `margin-export-<timestamp>.json`
- `margin-backup-<timestamp>.sqlite`

旧的两个 `run-echo-*.cmd` 在本阶段保留为兼容包装器，调用对应的 Margin 脚本，并输出一次弃用提示。旧文件不得复制维护另一套启动逻辑。

导入工具必须继续接受旧的 `echo-export-*.json` 和包含 legacy schema 字段的快照。

### 5.6 文档分层

文档按用途分为三类：

1. **当前规范**：标题、正文和示例统一为 Margin；旧配置只在兼容章节出现。
2. **历史材料**：保留原文，在文档顶部增加历史状态说明，明确 Echo 是旧名称。
3. **产品演进证据**：Case Study 的“从 Echo 到 Margin”章节原样保留。

不能通过机械替换把历史叙事改写成“Margin 到 Margin”，也不能让当前操作指南继续把产品称为 Echo。

### 5.7 GitHub 与仓库目录

GitHub 仓库地址和本地目录属于外部标识，单独处理：

- 在 GitHub 仓库真正更名之前，公开链接继续使用可访问的旧地址；
- 仓库更名后再更新 README、Case Study 资源配置与公开站点；
- 本轮不重命名本地仓库目录，避免破坏工作树和本地工具路径；
- 后续如需重命名本地目录，必须在所有工作树清理后单独执行。

## 6. 代码结构

配置兼容逻辑应集中在配置层，业务代码不得自行读取 `MARGIN_*` 或 `ECHO_*`。

建议提供以下统一配置结果：

```js
{
  port,
  nodeEnv,
  logLevel,
  llmProvider,
  dbPath,
  compatibilityWarnings
}
```

数据库模块只消费解析后的 `dbPath`，provider registry 只消费解析后的 `llmProvider`。启动入口负责输出经过脱敏的 `compatibilityWarnings`。

这样可以避免环境变量回退逻辑散落在 `memoryStore`、provider 和脚本中。

## 7. 错误处理

- 新旧变量冲突时使用新变量，并记录不含值的警告；
- 无效 provider 阻止启动，错误信息指出生效变量；
- 旧数据库被采用时只提示，不自动迁移；
- 新旧默认数据库同时存在时固定选择 `margin.sqlite`，并提示旧库未被自动合并；
- 备份导入遇到不认识的版本或缺失核心数据时继续拒绝导入；
- 所有日志不得输出 API Key、数据库内容或完整用户路径。

## 8. 测试策略

### 8.1 配置测试

至少覆盖：

- 只设置 `MARGIN_*`；
- 只设置 `ECHO_*`；
- 新旧变量同时存在；
- 无变量时使用 Margin 默认值；
- 无效新 provider；
- 无效旧 provider。

### 8.2 数据路径测试

至少覆盖：

- 两个默认数据库都不存在；
- 只有 `echo.sqlite` 存在；
- 只有 `margin.sqlite` 存在；
- 两者同时存在；
- 显式新路径；
- 显式旧路径。

### 8.3 兼容测试

- 旧数据库可直接启动；
- 旧备份可导入；
- 新备份文件使用 Margin 文件名；
- legacy schema 字段仍存在于 API 和快照中；
- 旧启动脚本仍能转发到新入口。

### 8.4 回归测试

- `node --test test` 必须全部通过；
- Case Study 内容、隐私、网页与 PDF 测试必须通过；
- `git diff --check` 必须通过。

主仓库根目录包含多个 `.worktrees` 时，裸 `node --test` 会扫描不属于当前产品测试范围的工作树和备份目录。因此迁移过程中以 `node --test test` 作为明确的项目测试命令，并同步修正 `package.json` 的 `test` 脚本，避免环境相关误报。

## 9. 分阶段交付

### 阶段 A：配置与数据兼容

- 建立统一配置解析；
- 新增 `MARGIN_*`；
- 实现默认数据库探测；
- 保留并测试 `ECHO_*`。

### 阶段 B：运行入口与当前文案

- 更新包元信息、API 元信息、日志和 Electron 文案；
- 新增 Margin 启动脚本；
- 保留 Echo 兼容包装器；
- 更新 Docker 和部署配置。

### 阶段 C：备份与文档

- 新生成物改用 Margin 文件名；
- 保持旧快照导入兼容；
- 整理当前文档与历史文档标记；
- 保留 Case Study 演进章节。

### 阶段 D：外部标识

- 用户另行完成 GitHub 仓库更名后更新链接；
- 所有工作树完成清理后，再决定是否重命名本地目录。

## 10. 验收标准

迁移完成需同时满足：

- 新环境只使用 `MARGIN_*` 即可完整运行；
- 旧环境只使用 `ECHO_*` 仍可完整运行；
- 新旧配置冲突时稳定采用 `MARGIN_*`；
- 新安装默认创建 `margin.sqlite`；
- 已存在的 `echo.sqlite` 不迁移也能继续使用；
- 旧备份可导入，新备份使用 Margin 文件名；
- 当前界面、API 元信息、日志、脚本和维护文档不再把产品称为 Echo；
- legacy schema 字段保持兼容且有明确说明；
- Case Study 的历史演进叙事不被破坏；
- `node --test test`、Case Study 验证和 `git diff --check` 全部通过。

## 11. 后续弃用条件

只有在满足以下条件后，才允许另开版本移除 `ECHO_*`：

- 至少一个正式版本已经默认使用 `MARGIN_*`；
- 文档已持续说明旧变量弃用；
- 已提供数据库与配置迁移工具；
- 旧备份仍可通过明确导入路径恢复；
- 移除计划经过单独规格评审。
