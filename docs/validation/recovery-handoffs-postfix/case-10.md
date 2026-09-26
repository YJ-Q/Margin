<!-- benchmark-case: case-10 | session-id: 01a07564-99fa-72e0-b086-4a21e5011211 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T04:47:58.691Z；Repo Truth：2026-09-07T04:47:58.946Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** # Margin V2.1 — Electron Floating Host

实现第一个 Floating Window vertical slice。

## Goal

把现有 Margin Browser Surface 原样运行在 Electron 中：
```
Margin Core
├─ CLI V1
└─ Electron V2
     ↓
 existing localhost HTTP Surface
     ↓
 existing React UI
```

不要重做 UI 或 Handoff 逻辑。

## Architecture

采用已确定方案：

- Electron main process
- `createMarginSurface({ port: 0, host: "127.0.0.1" })`
- BrowserWindow 加载返回的 localhost origin
- Renderer：
  - `nodeIntegration: false`
  - `contextIsolation: true`
- CLI 继续直接调用 Core
- React 继续通过现有 HTTP API
- 不新增 Electron 专属业务状态/IPC API

## Required behavior

实现：

1. 单实例
   - 再次启动只 show/focus 已有窗口
   - 不启动第二个 HTTP Surface
2. Floating Window
   - 初始约 `460×680`
   - 可 resize
   - 合理 min size
   - 默认不 always-on-top
3. Tray
   - Show/Hide
   - Always on top
   - Quit
4. Window lifecycle
   - Close → hide
   - Quit → 真正关闭 Window + HTTP Surface + process
5. Existing product flow 必须真实可用
   - Workspace Overview
   - Recent Sessions
   - Resume Summary
   - Copy checkpoint
   - Save `.margin/HANDOFF.md`

## Packaging

使用 Electron Forge。

要求生产包：

- 不依赖 Vite dev server
- 不依赖当前 shell cwd
- 不依赖全局 Node
- 正确找到 packaged `web/dist`
- localhost 使用 ephemeral port

先完成 Windows x64 **package/make + 本机 smoke test**。

本 Slice 不做：

- 正式 code signing
- auto-update
- CI release pipeline

### Native dependency

项目存在 `better-sqlite3`。

不要因为它重构 Core。

只确认 Electron package/build 不会因为 native ABI 导致启动失败；若 Forge 打包阶段因此阻塞，先定位最小 packaging 处理方案。

## Important

不要加入：

- Floating UI redesign
- live Agent monitoring
- usage
- Agent launcher
- checkpoint lifecycle
- search/archive/delete
- Workbench
- new IPC business transport

Electron 只是现有 Margin Surface 的桌面宿主。

## Validation

必须验证真实 packaged app，而不只是 dev mode：

- app 能启动
- 真实 Sessions / Workspaces 可见
- Generate/Copy/Save 真实 pipeline 可用
- `.margin/HANDOFF.md` 写入正确 Workspace
- Close → hide
- Tray show/hide
- Always-on-top toggle
- 第二次启动只聚焦原实例
- Quit 后 localhost listener 与 Electron process 均退出
- CLI V1 不回归
- focused tests + build + `git diff --check`

记录实际 package size 和启动/空闲资源占用即可，**只作为基线，不为优化数字改架构。**

## Output

1. Electron architecture
2. Lifecycle implementation
3. Packaging setup
4. Files changed
5. Tests
6. Packaged-app real validation
7. Tray / single-instance validation
8. Existing Margin flow regression
9. Package/resource baseline
10. Blockers/deviations
11. Verdict

最终：

`PASS — V2.1 Electron Host complete`

或

`PARTIAL — <specific blocker>`

完成后停止，不开始 V2.2。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；112 个已跟踪修改/未跟踪文件。

## Progress

- **Confirmed · Historical** Historical validation: 3 focused test commands exited 0.

- **Uncertain · Historical** Historical validation: 3 focused test commands had no explicit final result.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** PARTIAL — Forge `make` is blocked by Electron-header download `ECONNRESET` while rebuilding `better-sqlite3`; the host implementation and a real packaged-app functional smoke passed.

## Historical Pending / Blockers

- **Inferred · Historical** blocked by Electron-header download `ECONNRESET` while rebuilding `better-sqlite3`; the host implementation and a real packaged-app functional smoke passed.

## 已完成（事实范围）

- **Confirmed** 历史命令进程已成功返回：.\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginSurfaceHttpAdapter.test.js test/marginWorkspaceOverview.test.js test/marginCli.test.js; npm...（exit_code=0）；不代表之后文件仍未变化。（同一事实重复出现 2 次，仅展示一次）

- **Confirmed** 历史命令进程已成功返回：.\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js; $log = Join-Path (Get-Location) 'electron-package-2.log'; $err = Join-Path (Get-Location) 'electron-p...（exit_code=0）；不代表之后文件仍未变化。

## 失败 / 已拒绝

- **Confirmed** 命令进程失败：npm ls electron @electron-forge/cli @electron-forge/plugin-auto-unpack-natives; npm exec electron -- --version; npm test -- --test-name-pattern "Margin|margin surface|margin CLI"；npm error code ELSPROBLEMS

- **Confirmed** 命令进程失败：npm install；npm error code 1（同一事实重复出现 2 次，仅展示一次）

- **Confirmed** 命令进程失败：Get-Item "$env:TEMP\electron-v40.10.6-win32-x64.zip" -ErrorAction SilentlyContinue | Select-Object Length,LastWriteTime; Get-ChildItem node_modules\electron\dist -Force -ErrorAc...；Error: Electron failed to install correctly, please delete node_modules/electron and try installing again

- **Confirmed** 命令进程失败：curl.exe -L -C - "https://github.com/electron/electron/releases/download/v40.10.6/electron-v40.10.6-win32-x64.zip" -o "$env:TEMP\electron-v40.10.6-win32-x64.zip"；exit_code=1

- **Confirmed** 命令进程失败：npm install --ignore-scripts; $electronZip = Join-Path $env:TEMP 'electron-v40.10.6-win32-x64.zip'; Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/downloa...；Error: Electron failed to install correctly, please delete node_modules/electron and try installing again

- **Confirmed** 命令进程失败：Get-Item 'C:\Users\<user>\AppData\Local\Temp\electron-v40.10.6-win32-x64.zip' | Select-Object Length; Expand-Archive -LiteralPath 'C:\Users\<user>\AppData\Local\Temp\electron-v40.10.6...；Error: Electron failed to install correctly, please delete node_modules/electron and try installing again

- **Confirmed** 命令进程失败：Expand-Archive -LiteralPath 'C:\Users\<user>\AppData\Local\Temp\electron-v40.10.6-win32-x64.zip' -DestinationPath 'node_modules\electron\dist' -Force; Get-ChildItem 'node_modules\e...；Error: Electron failed to install correctly, please delete node_modules/electron and try installing again

- **Confirmed** 命令进程失败：Set-Content -LiteralPath 'node_modules\electron\path.txt' -Value 'electron.exe' -NoNewline; Get-Content -LiteralPath 'node_modules\electron\path.txt' -Raw | Format-Hex; & 'node_...；exit_code=1

- **Confirmed** 命令进程失败：Get-ChildItem out -Force -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime; Get-Process electron-forge,node,electron -ErrorAction SilentlyContinue | Select...；exit_code=1

- **Confirmed** 命令进程失败：Get-Process -Id 40844,40852 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,StartTime; Get-ChildItem out -Force -ErrorAction SilentlyContinue | Select-Object Na...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 20; Get-Process -Id 40844,40852 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,StartTime; Get-ChildItem out -Force -ErrorAction SilentlyCo...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 30; Get-Process -Id 40844,40852 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,StartTime; Get-ChildItem out -Force -ErrorAction SilentlyCo...；exit_code=1

- **Confirmed** 命令进程失败：& 'node_modules\.bin\electron.cmd' --version; "status=$LASTEXITCODE"; npm run electron:package；Error: spawn <repo>\node_modules\electron\dist\electron.exe

- **Confirmed** 命令进程失败：Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-2) } | Select-Object Id,CPU,StartTime,Path; Get-ChildItem out -Force -Err...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 25; Get-Process -Id 10100,29052,31228 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,StartTime; Get-ChildItem out -Force -ErrorAction Sile...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 30; Get-Process -Id 10100,29052,31228 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,StartTime; Get-ChildItem out -Force -ErrorAction Sile...；exit_code=1

- **Confirmed** 命令进程失败：npm run electron:package；Error: ENOENT: no such file or directory, rename 'C:\Temp\electron-packager\tmp-72yIEn\electron.exe' -> 'C:\Temp\electron-packager\tmp-72yIEn\margin.exe'

- **Confirmed** 命令进程失败：Get-Process -Id 16772 -ErrorAction SilentlyContinue | Select-Object Id,CPU,StartTime; Get-ChildItem out -Force -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWrit...；exit_code=1

- **Confirmed** 命令进程失败：Get-Item electron-package.log,electron-package.err.log -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime; Get-Process -Id 9804 -ErrorAction SilentlyContinu...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 25; Get-Content electron-package-4.log -Tail 12; Get-Content electron-package-4.err.log -Tail 12; Get-ChildItem out-electron -Force -ErrorAction SilentlyCon...；exit_code=1（同一事实重复出现 3 次，仅展示一次）

- **Confirmed** 命令进程失败：$origin = 'http://127.0.0.1:50903'; $sessions = Invoke-RestMethod "$origin/api/sessions?limit=8"; $session = $sessions.data.sessions[0]; $overview = Invoke-RestMethod "$origin/a...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 25; Get-Content electron-package-6.log -Tail 12; Get-Content electron-package-6.err.log -Tail 8; Get-ChildItem out-electron-v2 -Force -ErrorAction SilentlyC...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 25; Get-Content electron-make.log -Tail 14; Get-Content electron-make.err.log -Tail 8; Get-ChildItem out-electron-final -Force -ErrorAction SilentlyContinue...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 25; Get-Content electron-make-final.log -Tail 18; Get-Content electron-make-final.err.log -Tail 10; Get-ChildItem 'out-electron-release\make' -Recurse -File...；exit_code=1

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 25; Get-Content electron-make-short.log -Tail 20; Get-Content electron-make-short.err.log -Tail 12; Get-ChildItem 'out2\make' -Recurse -File -ErrorAction Si...；Error: C:\Temp\electron-packager\tmp-6LEtpA\resources\app\out-electron-release\margin-win32-x64\resources\app.asar: file size can not be larger than 4.2GB

- **Confirmed** 命令进程失败：Start-Sleep -Seconds 25; Get-Content electron-make-clean.log -Tail 22; Get-Content electron-make-clean.err.log -Tail 12; Get-ChildItem 'out2\make' -Recurse -File -ErrorAction Si...；Error: C:\Temp\electron-packager\tmp-R1W4VY\resources\app\out-electron-release\margin-win32-x64\resources\app.asar: file size can not be larger than 4.2GB

- **Confirmed** 命令进程失败：where.exe python 2>$null; where.exe py 2>$null; Get-ChildItem 'C:\Users\<user>\AppData\Local\Programs\Python' -Recurse -Filter python.exe -ErrorAction SilentlyContinue | Select-Obj...；exit_code=1

## Open Issues

- **Uncertain** 144 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginSurfaceHttpAdapter.test.js test/marginWorkspaceOverview.test.js test/marginCli.test.js; npm...：succeeded；exit_code=0。

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js; $log = Join-Path (Get-Location) 'electron-package-2.log'; $err = Join-Path (Get-Location) 'electron-p...：succeeded；exit_code=0。

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginSurfaceHttpAdapter.test.js test/marginWorkspaceOverview.test.js test/marginCli.test.js; npm...：succeeded；exit_code=0。

- **Uncertain** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginSurfaceHttpAdapter.test.js test/marginWorkspaceOverview.test.js test/marginCli.test.js; npm...：unknown；No explicit success/failure in result。

- **Uncertain** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js; $log = Join-Path (Get-Location) 'electron-package-2.log'; $err = Join-Path (Get-Location) 'electron-p...：unknown；No explicit success/failure in result。

- **Uncertain** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginSurfaceHttpAdapter.test.js test/marginWorkspaceOverview.test.js test/marginCli.test.js; npm...：unknown；No explicit success/failure in result。

## Historical Intent

- **Inferred** Implemented:

## Current Applicability

- **Unknown** No structured repo targets are available for reconciliation.

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-postfix\session-01a07564-99fa-72e0-b086-4a21e5011211.jsonl
- SHA-256：e67c3558ccfaf9199c5590612dbde28938d38f7448a2af614bff9bf93a69080b
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
