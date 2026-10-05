# RainyAgent

[English](README.md) | 中文

RainyAgent 是 Windows 桌面编程 Agent，提供代码编辑器、AI 对话、项目记忆和供人操作的工具工作台。核心安装包包含 Windows Host 和完整 Strata 运行时，用户自行提供受支持的模型权重。命令可在 Windows 原生或选定的 WSL2 环境中执行，也可继续连接其他本地服务或 API。

Develop by NCUCyberBase.

![RainyAgent 工作区](apps/rainy-desktop/assets/workbench.png)

## 主要功能

- Monaco 编辑器，支持文件标签、搜索、差异视图、未保存内容恢复和选中代码对话。
- 项目终端、运行配置，以及 Python、JavaScript/TypeScript、C/C++ 调试；PHP 支持运行。
- 内置 Strata 与 Python、模型发现、明确的上下文预算、请求诊断，以及可分别控制使用和生成的项目记忆。
- 可选离线运行环境和包含 38 项工具的人工工具目录，与 Agent 默认工具分开。
- 稳定版检查和后台下载，只有确认并完成保存退出后才安装更新。

<a id="run"></a>
## 下载与开始使用

下载 [RainyAgent 1.0.0 Windows x64 安装包](https://github.com/RainyMarks/RainyAgent/releases/download/v1.0.0/RainyAgent-1.0.0-windows-x64-setup.exe)。[v1.0.0 发行页](https://github.com/RainyMarks/RainyAgent/releases/tag/v1.0.0)提供更新说明、校验清单及可选离线输入。

安装核心应用，从桌面快捷方式打开 RainyAgent，然后选择**文件 → 打开文件夹**。新安装直接使用 Windows；WSL2 和离线环境组件均为可选项。无需激活码。核心 EXE 已包含 Windows Host、Strata 引擎、Python 及其运行依赖；主模型与 MTP 权重不放入安装包。

自动更新替换核心应用，不会重新下载可选工具包、WSL 介质或科学计算环境。下载完成后可选择**稍后**或**重启安装**；普通退出不会安装更新。

## 连接模型

### 内置 Strata

核心应用包含 [Niko1221/Strata 0.1.39](https://github.com/Niko1221/Strata/releases/tag/v0.1.39) 和 Python 3.12.14。其推理引擎面向 Windows x64 与 NVIDIA CUDA 13，要求 580 或更新驱动，包含 `sm75`、`sm86`、`sm89`、`sm120` GPU 目标；本包不提供 AMD 或 Linux 推理引擎。请准备受支持的 Qwen3.8 Flash Next 主模型 GGUF 及全部分片，以及配套 MTP GGUF 或已准备运行目录；发行包不含模型权重或派生的 dense/expert 数据包。

1. 打开**设置 → 模型与上下文 → Strata 本地模型**，选择主模型与配套 MTP 文件，或导入兼容的 Strata profile。MTP 路径留空时会尝试从模型附近自动检测。
2. 保存上下文长度和本地端口，再点击**启动本地模型**。首次明确启动会在本机准备所需模型文件，不执行下载；准备和启动均可取消。
3. 就绪后点击**连接并设为默认**。当前 Host 验证实际模型与上下文后才选用它；推理档位和每次请求的输出上限仍在下方普通模型设置中调整。

RainyAgent 只停止自己启动的进程。若 NAT 下的 WSL Host 无法访问 Windows loopback 服务，请为 Strata 选择 Windows 执行环境。资源控制和当前验证范围见[桌面指南](apps/rainy-desktop/README.zh.md#strata-local-inference)。

### 已有服务或 API

1. 打开**设置 → 模型与上下文**，填写供应商 ID、服务 Base URL、协议及必要的密钥。
2. 点击**发现模型**，或手动填写模型 ID。发现模型不要求预先填写模型 ID 或上下文长度。
3. 设置服务实际的上下文窗口和输出上限，保存配置，再执行流式与工具调用诊断。

所选 Windows 或 WSL Host 必须能够访问服务地址。RainyAgent 将密钥保存在该 Host 的私有凭据存储中，不会静默切换到云端模型。运行环境、恢复和配置细节见[桌面说明](apps/rainy-desktop/README.zh.md)和[中文安装指南](apps/rainy-desktop/README.zh-CN.md)。

<a id="run-from-source"></a>
## 从源码构建

构建 Windows 发行包需要 Node.js `^22.19 || >=24`、pnpm `11.7.0`，以及[构建指南](apps/rainy-desktop/README.zh-CN.md#从源码构建)列出的 Windows/WSL 环境。输入清单会从发行资产恢复固定版本的二进制资源，包括 `build-inputs/strata-runtime.tar.gz`；Strata 由 bootstrap 命令自动恢复，这些资源不提交到 Git。

```powershell
git clone https://github.com/RainyMarks/RainyAgent.git
cd RainyAgent
pnpm install --frozen-lockfile
node apps/rainy-desktop/scripts/bootstrap-release-inputs.mjs --manifest apps/rainy-desktop/toolpacks/build-inputs.v1.json
pnpm run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/rainy-desktop/scripts/package.ps1 -SkipUpstreamBuild -Distribution Ubuntu -ReuseNativeToolsRelease apps/rainy-desktop/release/offline-1.0.0 -ComponentSource apps/rainy-desktop/release/offline-1.0.0/environment-components
```

只有已准备的 WSL 构建发行版名称不同时，才替换命令中的 `Ubuntu`。[验收记录](apps/rainy-desktop/VALIDATION.md)按具体产物记录已经完成的构建、安装和运行检查；源码构建说明本身不代表干净机器验收结果。

## 许可与归属

RainyAgent 由独立团队维护。上游基线为 [DeepSeek Harness 0.1.7-rc.2，提交 477b4f420553e8a52c2fbccc464d7561b239c443](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)；保留的上游代码及其原有包目录中的改动继续使用 [MIT](LICENSE.upstream)。

RainyAgent 集成代码使用 [RainyAgent Source Available License 1.0](LICENSE.RainyAgent)。允许个人和企业内部免费使用、修改及非商业再分发；销售、收费托管和商业再分发需要另行书面许可。本项目属于源码可用项目，不是 OSI 认可的开源发行版。具体范围见[许可说明](LICENSE)和[桌面第三方声明](apps/rainy-desktop/THIRD_PARTY_NOTICES.md)。

问题反馈请使用 [GitHub Issues](https://github.com/RainyMarks/RainyAgent/issues)。开发者可从[架构](docs/architecture.zh.md)、[开发指南](docs/development.zh.md)和 [AGENTS.md](AGENTS.md)开始。
